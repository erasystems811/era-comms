// ── AI LAYER INTERFACES ───────────────────────────────────────
//
// The AI layer is model-agnostic. No provider is referenced outside
// of its own implementation file. All callers depend only on these
// interfaces.

// Task types drive model routing. Routing is automatic and task-based —
// clients never configure this. The classifier assigns a type; the router
// maps it to a provider.
export type TaskType =
  | 'variation'             // Paraphrase outbound message before send. Must be fast and cheap.
  | 'simple_conversation'   // Short context, clear intent, no judgment required.
  | 'complex_conversation'  // Objection handling, long threads, judgment required.
  | 'premium_conversation'  // Claude: persona consistency and instruction-following priority.

// ── CLASSIFIER ────────────────────────────────────────────────
//
// All signals are measurable without a model call. The classifier is
// deterministic — same signals produce same task type every time.
// When signals conflict or confidence is ambiguous, default upward
// to the stronger model.

export interface ConversationSignals {
  turnCount: number
  contextTokens: number
  hasEscalationKeywords: boolean
  hasFlaggedTopics: boolean
  // -1.0 (strongly negative) to 1.0 (strongly positive)
  sentimentScore: number
  priorEscalations: number
}

export interface ITaskClassifier {
  classify(signals: ConversationSignals): TaskType
}

// ── PROVIDER ──────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AICompletionOptions {
  maxTokens?: number
  temperature?: number
}

export interface AICompletionResult {
  content: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface IAIProvider {
  readonly providerId: string
  complete(messages: ChatMessage[], options?: AICompletionOptions): Promise<AICompletionResult>
  // Yields string chunks as they arrive — used by voice pipeline to start TTS
  // before the full response is complete
  stream(messages: ChatMessage[], options?: AICompletionOptions): AsyncIterable<string>
}

// ── ROUTER ────────────────────────────────────────────────────
//
// Routing rules are configurable at runtime without a code change.
// The router reads rules from config or database; callers do not know
// which provider they are getting.

export interface IAIRouter {
  // Select the provider appropriate for this task type
  forTask(taskType: TaskType): IAIProvider
  // Convenience: classify signals and return the appropriate provider
  route(signals: ConversationSignals): IAIProvider
}

// ── VARIATION ─────────────────────────────────────────────────
//
// Every outbound message is paraphrased before sending.
// No two messages are ever identical in phrasing.

export interface IVariationEngine {
  // Returns a rephrased version of content with identical meaning.
  // Must not alter numbers, names, dates, or calls to action.
  vary(content: string, context?: string): Promise<string>
}
