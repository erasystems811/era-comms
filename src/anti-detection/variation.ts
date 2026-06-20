// ── MESSAGE VARIATION ENGINE ──────────────────────────────────
//
// Subtly rephrases outbound text messages to prevent WhatsApp's
// spam classifiers from fingerprinting repeated identical content.
// Only applied to human-authored text messages — AI-generated
// responses are already varied by the generation model.
//
// Falls back silently to the original on any AI error so a
// variation failure never blocks message delivery.

import OpenAI from 'openai'
import { config } from '../shared/config.js'
import type { WarmupStage } from './jitter.js'

const openai = new OpenAI({ apiKey: config.ai.openaiApiKey })

export interface VariationResult {
  content:    string
  wasVaried:  boolean
}

// Messages shorter than MIN_LENGTH are hard to rephrase without
// distorting meaning. Messages longer than MAX_LENGTH push up token
// usage without proportional safety benefit — send as-is.
const MIN_LENGTH = 20
const MAX_LENGTH = 600

const SYSTEM_PROMPT =
  'You are a message rewriting assistant. Rephrase the WhatsApp message below ' +
  'in a natural, conversational way that preserves its exact meaning, tone, and ' +
  'approximate length. Do not add or remove information. ' +
  'Reply with the rephrased message only — no quotes, no explanations.'

// During the conversational warmup stage the focus is human-like chat,
// not sales copy. Use a lower temperature to keep variations subtle.
function temperature(stage: WarmupStage): number {
  return stage === 'conversational' ? 0.5 : 0.7
}

export async function varyMessage(
  content: string,
  stage: WarmupStage,
  aiGenerated: boolean,
): Promise<VariationResult> {
  // Only vary human-authored text that is long enough to be rephrased safely.
  if (aiGenerated || content.length < MIN_LENGTH || content.length > MAX_LENGTH) {
    return { content, wasVaried: false }
  }

  try {
    const completion = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: temperature(stage),
      max_tokens:  Math.ceil(content.length / 3) + 80,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content },
      ],
    })

    const varied = completion.choices[0]?.message?.content?.trim()
    if (!varied || varied === content) return { content, wasVaried: false }

    return { content: varied, wasVaried: true }
  } catch {
    // Variation is best-effort — delivery always wins.
    return { content, wasVaried: false }
  }
}
