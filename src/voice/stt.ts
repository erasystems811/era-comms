// ── SPEECH-TO-TEXT ─────────────────────────────────────────────
//
// Transcribes a WAV file recorded by FreeSWITCH.
// Primary: Deepgram (low latency, streaming-capable)
// Fallback: OpenAI Whisper-1 (requires OPENAI_API_KEY)
//
// Both are accessed synchronously (batch transcription, not streaming).
// The call handler stops the recording before calling transcribe().

import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import OpenAI from 'openai'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ component: 'stt' })

// Lazy singletons — only constructed when needed
let openaiClient: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.ai.openaiApiKey })
  return openaiClient
}

export async function transcribe(audioPath: string): Promise<string> {
  try {
    if (config.voice.deepgramApiKey) {
      return await transcribeDeepgram(audioPath)
    }
    return await transcribeWhisper(audioPath)
  } finally {
    // Always clean up the temp audio file
    await unlink(audioPath).catch(() => {})
  }
}

async function transcribeDeepgram(audioPath: string): Promise<string> {
  const apiKey = config.voice.deepgramApiKey!
  const start = Date.now()

  // Deepgram HTTP API — no SDK required
  const stream = createReadStream(audioPath)
  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=false', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: stream as unknown as BodyInit,
    // @ts-expect-error — Node.js 20 fetch accepts Node streams
    duplex: 'half',
  })

  if (!response.ok) {
    throw new Error(`Deepgram STT failed: ${response.status} ${response.statusText}`)
  }

  type DeepgramResult = {
    results: { channels: Array<{ alternatives: Array<{ transcript: string }> }> }
  }
  const data = (await response.json()) as DeepgramResult
  const transcript = data.results?.channels[0]?.alternatives[0]?.transcript ?? ''

  log.debug({ ms: Date.now() - start, chars: transcript.length }, 'STT via Deepgram')
  return transcript.trim()
}

async function transcribeWhisper(audioPath: string): Promise<string> {
  const start = Date.now()
  const client = getOpenAI()

  const response = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file:  createReadStream(audioPath),
  })

  log.debug({ ms: Date.now() - start, chars: response.text.length }, 'STT via Whisper')
  return response.text.trim()
}
