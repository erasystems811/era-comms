// ── VOICE AI RESPONSE GENERATOR ────────────────────────────────
//
// Generates a conversational AI response for a voice call turn.
// Voice constraints applied automatically:
//   - 1-3 sentences maximum (fits within TTS processing time budget)
//   - No markdown, bullet points, or formatting
//   - Natural speech rhythm
//
// Uses GPT-4o-mini for speed. Voice calls are time-sensitive — the user
// is listening in real time, so latency matters more than model quality.
// Premium voice uses GPT-4o (configured per voice_profile.level).

import OpenAI from 'openai'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import type { TranscriptTurn } from '../db/schema/voice.js'

const log = logger.child({ component: 'voice-ai' })

let openaiClient: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.ai.openaiApiKey })
  return openaiClient
}

// Prefix appended before the client's system prompt for every voice call
const VOICE_SYSTEM_PREFIX = `You are speaking on a phone call. Your responses will be read aloud. Keep every response to 1-3 natural sentences. Never use markdown, bullet points, numbered lists, or any formatting. Speak clearly and conversationally.

`

type ProfileRow = { system_prompt: string; persona: string; tone: string }

export async function loadVoiceSystemPrompt(clientId: string): Promise<string> {
  // Load the latest published profile version for this client
  const rows = (await adminDb`
    SELECT pv.system_prompt, pv.persona, pv.tone
    FROM   communication_profile_versions pv
    JOIN   communication_profiles cp ON cp.current_version_id = pv.id
    WHERE  cp.client_id = ${clientId}
  `) as unknown as ProfileRow[]

  const profile = rows[0]
  if (!profile) return VOICE_SYSTEM_PREFIX

  return `${VOICE_SYSTEM_PREFIX}${profile.system_prompt}`
}

export async function generateVoiceResponse(
  systemPrompt: string,
  transcript:   TranscriptTurn[],
  premium:      boolean,
): Promise<string> {
  const model = premium ? 'gpt-4o' : 'gpt-4o-mini'
  const client = getOpenAI()

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...transcript.map((t): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
      role:    t.role === 'user' ? 'user' : 'assistant',
      content: t.text,
    })),
  ]

  const start = Date.now()
  const completion = await client.chat.completions.create({
    model,
    messages,
    max_tokens:  150,  // ~3 sentences — keeps TTS latency low
    temperature: 0.7,
  })

  const text = completion.choices[0]?.message.content?.trim() ?? ''
  log.debug({ ms: Date.now() - start, model, chars: text.length }, 'Voice AI response')
  return text
}
