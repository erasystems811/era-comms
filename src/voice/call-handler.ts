// ── PER-CALL STATE MACHINE ─────────────────────────────────────
//
// Drives a single FreeSWITCH voice call through the STT → AI → TTS loop.
//
// Flow:
//   answer → greet (TTS) → loop:
//     record (30s max, silence detection)
//     STT transcript
//     if empty → reprompt (max 2 attempts) → hangup
//     if farewell phrase → hangup
//     AI response → TTS → play
//   until MAX_TURNS or hangup
//
// DB writes:
//   - INSERT voice_calls on start
//   - INSERT/UPSERT contacts
//   - UPDATE voice_calls (transcript, status, duration) on end
//
// Temp files (WAV recordings, TTS audio) are deleted after each use.

import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { transcribe } from './stt.js'
import { synthesize } from './tts.js'
import { loadVoiceSystemPrompt, generateVoiceResponse } from './voice-ai.js'
import type { ESLClient, ESLEvent } from './esl-client.js'
import type { TranscriptTurn } from '../db/schema/voice.js'

const log = logger.child({ component: 'call-handler' })

const MAX_TURNS = 10
const RECORD_MAX_SECONDS = 30
const SILENCE_THRESHOLD  = 200  // FS amplitude threshold
const SILENCE_HITS       = 25   // 25 × 20ms = 500ms of silence stops recording

const FAREWELL_PHRASES = ['bye', 'goodbye', 'that\'s all', 'thank you goodbye', 'hang up']

type CallRow = { id: string }
type ContactRow = { id: string }

export async function handleCall(
  esl:          ESLClient,
  uuid:         string,
  fromNumber:   string,     // caller's E.164 number
  toNumber:     string,     // destination (client's number)
  clientId:     string,
  voiceProfile: { id: string; level: string; clonedVoiceId: string | null } | null,
): Promise<void> {
  const callLog = log.child({ uuid, fromNumber })
  const callStart = Date.now()
  const transcript: TranscriptTurn[] = []
  let callDbId: string | null = null

  callLog.info('Call handler started')

  try {
    // ── ENSURE AUDIO DIRECTORY ────────────────────────────────
    await mkdir(config.voice.audioDir, { recursive: true })

    // ── FIND OR CREATE CONTACT ────────────────────────────────
    const contactRows = (await adminDb`
      INSERT INTO contacts (client_id, phone_number)
      VALUES (${clientId}, ${fromNumber})
      ON CONFLICT (client_id, phone_number) DO UPDATE
        SET last_contacted_at = NOW(), updated_at = NOW()
      RETURNING id
    `) as unknown as ContactRow[]
    const contactId = contactRows[0]!.id

    // ── INSERT VOICE CALL RECORD ──────────────────────────────
    const callRows = (await adminDb`
      INSERT INTO voice_calls (
        client_id, contact_id, voice_profile_id,
        from_number, to_number, status, freeswitch_call_uuid
      ) VALUES (
        ${clientId}, ${contactId}, ${voiceProfile?.id ?? null},
        ${fromNumber}, ${toNumber}, 'in_progress', ${uuid}
      )
      RETURNING id
    `) as unknown as CallRow[]
    callDbId = callRows[0]!.id

    // ── LOAD AI SYSTEM PROMPT ─────────────────────────────────
    const systemPrompt = await loadVoiceSystemPrompt(clientId)
    const premium      = voiceProfile?.level === 'enterprise' || voiceProfile?.level === 'premium'
    const speakerId    = voiceProfile?.clonedVoiceId ?? null

    // ── ANSWER THE CALL ───────────────────────────────────────
    await esl.executeAndWait(uuid, 'answer')
    callLog.debug('Call answered')

    // Small delay — gives the caller time to hear the ring stop
    await esl.executeAndWait(uuid, 'sleep', '800')

    // ── GREETING ──────────────────────────────────────────────
    const greetingFile = join(config.voice.audioDir, `greeting_${uuid}.wav`)
    await synthesize(
      systemPrompt.includes('Hello') ? 'Hello! How can I help you today?' : 'Hello, how can I assist you?',
      greetingFile,
      speakerId,
    )
    await playFile(esl, uuid, greetingFile)

    // ── CONVERSATION LOOP ─────────────────────────────────────
    let emptyAttempts = 0

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Record caller speech
      const recFile = join(config.voice.audioDir, `rec_${uuid}_${turn}.wav`)
      const recorded = await recordSpeech(esl, uuid, recFile)

      if (!recorded) {
        callLog.debug({ turn }, 'Hangup detected during recording')
        break
      }

      // STT
      const transcript_ = await transcribe(recFile).catch((err: unknown) => {
        callLog.warn({ err }, 'STT failed — reprompting')
        return ''
      })

      if (!transcript_ || transcript_.length < 2) {
        emptyAttempts++
        if (emptyAttempts >= 2) {
          await speakAndPlay(esl, uuid, "I'm sorry, I didn't catch that. Let me transfer you.", speakerId, `empty_${uuid}.wav`)
          break
        }
        await speakAndPlay(esl, uuid, "I didn't quite catch that — could you repeat?", speakerId, `reprompt_${uuid}_${turn}.wav`)
        continue
      }

      emptyAttempts = 0
      transcript.push({ role: 'user', text: transcript_, ts: new Date().toISOString() })

      // Farewell detection
      if (FAREWELL_PHRASES.some(p => transcript_.toLowerCase().includes(p))) {
        callLog.debug({ turn }, 'Farewell detected — ending call')
        await speakAndPlay(esl, uuid, "Goodbye! Have a wonderful day.", speakerId, `bye_${uuid}.wav`)
        break
      }

      // AI response
      let aiText: string
      try {
        aiText = await generateVoiceResponse(systemPrompt, transcript, premium)
      } catch (err) {
        callLog.warn({ err }, 'Voice AI failed')
        await speakAndPlay(esl, uuid, "I'm having trouble right now. Please try again shortly.", speakerId, `err_${uuid}_${turn}.wav`)
        break
      }

      if (!aiText) break

      transcript.push({ role: 'assistant', text: aiText, ts: new Date().toISOString() })

      // TTS + play
      const ttsFile = join(config.voice.audioDir, `tts_${uuid}_${turn}.wav`)
      await synthesize(aiText, ttsFile, speakerId)
      await playFile(esl, uuid, ttsFile)
    }

  } catch (err) {
    const isHangup = err instanceof Error && err.message.includes('hung up')
    if (!isHangup) callLog.error({ err }, 'Call handler error')
  } finally {
    // ── FINALISE CALL RECORD ──────────────────────────────────
    const durationSeconds = Math.round((Date.now() - callStart) / 1000)
    if (callDbId) {
      await adminDb`
        UPDATE voice_calls
        SET status           = 'completed',
            ended_at         = NOW(),
            duration_seconds = ${durationSeconds},
            transcript       = ${JSON.stringify(transcript)}::jsonb,
            updated_at       = NOW()
        WHERE id = ${callDbId}
      `.catch((e: unknown) => callLog.warn({ e }, 'Failed to finalise voice_call record'))
    }
    callLog.info({ durationSeconds, turns: Math.ceil(transcript.length / 2) }, 'Call ended')
  }
}

// ── HELPERS ──────────────────────────────────────────────────────

async function recordSpeech(esl: ESLClient, uuid: string, filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const onHangup = (evt: ESLEvent) => {
      if (evt['Unique-ID'] !== uuid) return
      esl.off('CHANNEL_HANGUP', onHangup)
      esl.off('RECORD_STOP', onStop)
      resolve(false)
    }
    const onStop = (evt: ESLEvent) => {
      if (evt['Unique-ID'] !== uuid) return
      esl.off('CHANNEL_HANGUP', onHangup)
      esl.off('RECORD_STOP', onStop)
      resolve(true)
    }
    esl.on('CHANNEL_HANGUP', onHangup)
    esl.on('RECORD_STOP', onStop)
    esl.sendmsg(uuid, 'record', `${filePath} ${RECORD_MAX_SECONDS} ${SILENCE_THRESHOLD} ${SILENCE_HITS}`)
  })
}

async function playFile(esl: ESLClient, uuid: string, filePath: string): Promise<void> {
  try {
    await esl.executeAndWait(uuid, 'playback', filePath)
  } finally {
    // Delete file after playback (or on error)
    const { unlink } = await import('node:fs/promises')
    await unlink(filePath).catch(() => {})
  }
}

async function speakAndPlay(
  esl:        ESLClient,
  uuid:       string,
  text:       string,
  speakerId:  string | null,
  filename:   string,
): Promise<void> {
  const path = join(config.voice.audioDir, filename)
  await synthesize(text, path, speakerId)
  await playFile(esl, uuid, path)
}
