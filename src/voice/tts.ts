// ── TEXT-TO-SPEECH ─────────────────────────────────────────────
//
// Converts AI-generated text to a WAV audio file for FreeSWITCH playback.
// Uses the local Coqui TTS service (XTTS v2 for voice cloning support).
// Falls back to OpenAI TTS if the Coqui service is unreachable.
//
// Output format: WAV (preferred by FreeSWITCH over MP3 for lower latency).
// The caller is responsible for deleting the output file after playback.

import { writeFile } from 'node:fs/promises'
import OpenAI from 'openai'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ component: 'tts' })

let openaiClient: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.ai.openaiApiKey })
  return openaiClient
}

// voiceSampleId: Coqui speaker ID from voice_profiles.cloned_voice_id
// If null, uses the default ERA voice
export async function synthesize(
  text:           string,
  outputPath:     string,
  voiceSampleId?: string | null,
): Promise<void> {
  const start = Date.now()
  try {
    await synthesizeCoqui(text, outputPath, voiceSampleId)
    log.debug({ ms: Date.now() - start, chars: text.length }, 'TTS via Coqui')
  } catch (err) {
    log.warn({ err }, 'Coqui TTS failed — falling back to OpenAI TTS')
    await synthesizeOpenAI(text, outputPath)
    log.debug({ ms: Date.now() - start }, 'TTS via OpenAI fallback')
  }
}

async function synthesizeCoqui(
  text: string,
  outputPath: string,
  speakerId?: string | null,
): Promise<void> {
  const params = new URLSearchParams({ text })
  if (speakerId) params.set('speaker_id', speakerId)

  const url = `${config.voice.tts.serviceUrl}/api/tts?${params.toString()}`
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })

  if (!response.ok) {
    throw new Error(`Coqui TTS HTTP ${response.status}: ${await response.text()}`)
  }

  const buf = await response.arrayBuffer()
  await writeFile(outputPath, Buffer.from(buf))
}

async function synthesizeOpenAI(text: string, outputPath: string): Promise<void> {
  const client = getOpenAI()
  const mp3 = await client.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text,
    response_format: 'wav',
  })
  const buf = Buffer.from(await mp3.arrayBuffer())
  await writeFile(outputPath, buf)
}
