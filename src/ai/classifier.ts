// ── TASK CLASSIFIER ───────────────────────────────────────────
//
// Rules-based, deterministic — same signals always produce the same
// TaskType. No model calls. When signals conflict, default upward to
// the stronger model rather than risk poor handling.

import type { ITaskClassifier, ConversationSignals, TaskType } from '../interfaces/ai.js'

export class TaskClassifier implements ITaskClassifier {
  classify(signals: ConversationSignals): TaskType {
    const { turnCount, contextTokens, hasEscalationKeywords,
            hasFlaggedTopics, sentimentScore, priorEscalations } = signals

    // Hard signals → complex regardless of everything else
    if (hasFlaggedTopics || priorEscalations > 0) return 'complex_conversation'

    // Long threads need stronger reasoning capacity
    if (contextTokens > 3_000 || turnCount > 15) return 'complex_conversation'

    // Escalation signal + negative sentiment together → complex
    if (hasEscalationKeywords && sentimentScore < -0.3) return 'complex_conversation'

    // Strong negative sentiment alone
    if (sentimentScore < -0.5) return 'complex_conversation'

    return 'simple_conversation'
  }
}

export const taskClassifier = new TaskClassifier()

// ── SENTIMENT HEURISTIC ───────────────────────────────────────
//
// Deterministic keyword count — not a model call. Score is in [-1, 1].
// Accuracy is intentionally low; the purpose is to catch obviously
// negative interactions before they become escalations.

const NEG_WORDS = new Set([
  'angry', 'furious', 'frustrated', 'terrible', 'awful', 'horrible',
  'disgusting', 'useless', 'worthless', 'scam', 'fraud', 'lawsuit',
  'refund', 'cancel', 'hate', 'worst', 'rude', 'incompetent',
  'unacceptable', 'pathetic', 'ridiculous', 'never again', 'waste',
])

const POS_WORDS = new Set([
  'thank', 'thanks', 'great', 'love', 'perfect', 'excellent', 'amazing',
  'wonderful', 'happy', 'satisfied', 'helpful', 'appreciate', 'pleased',
  'fantastic', 'brilliant', 'awesome', 'superb',
])

export function estimateSentiment(text: string): number {
  const lower = text.toLowerCase()
  const words = lower.split(/\W+/)
  let pos = 0
  let neg = 0
  for (const w of words) {
    if (POS_WORDS.has(w)) pos++
    if (NEG_WORDS.has(w)) neg++
  }
  const total = Math.max(1, words.length)
  return Math.max(-1, Math.min(1, (pos - neg * 2) / Math.sqrt(total)))
}
