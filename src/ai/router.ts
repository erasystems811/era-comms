// ── AI ROUTER ─────────────────────────────────────────────────
//
// Maps task types to providers. Callers never reference a specific
// model — they call forTask() or route() and get back an IAIProvider.
//
// Routing table:
//   simple_conversation   → GPT-4o-mini  (fast, cheap, good enough)
//   complex_conversation  → GPT-4o       (stronger reasoning)
//   premium_conversation  → GPT-4o       (strong reasoning)
//   variation             → handled by anti-detection layer directly

import type { IAIRouter, IAIProvider, TaskType, ConversationSignals } from '../interfaces/ai.js'
import { taskClassifier } from './classifier.js'
import { gpt4oMini, gpt4o } from './providers/openai-provider.js'

const ROUTING_TABLE: Record<TaskType, IAIProvider> = {
  variation:            gpt4oMini,
  simple_conversation:  gpt4oMini,
  complex_conversation: gpt4o,
  premium_conversation: gpt4o,
}

class AIRouter implements IAIRouter {
  forTask(taskType: TaskType): IAIProvider {
    return ROUTING_TABLE[taskType]
  }

  route(signals: ConversationSignals): IAIProvider {
    return this.forTask(taskClassifier.classify(signals))
  }
}

export const aiRouter = new AIRouter()
