import OpenAI from 'openai'
import { config } from '../../shared/config.js'
import type {
  IAIProvider,
  ChatMessage,
  AICompletionOptions,
  AICompletionResult,
} from '../../interfaces/ai.js'

export class OpenAIProvider implements IAIProvider {
  private readonly client: OpenAI
  readonly providerId: string

  constructor(private readonly model: string) {
    this.providerId  = `openai/${model}`
    this.client      = new OpenAI({ apiKey: config.ai.openaiApiKey })
  }

  async complete(
    messages: ChatMessage[],
    options: AICompletionOptions = {},
  ): Promise<AICompletionResult> {
    const res = await this.client.chat.completions.create({
      model:       this.model,
      messages,
      max_tokens:  options.maxTokens  ?? 500,
      temperature: options.temperature ?? 0.7,
    })

    return {
      content:      res.choices[0]?.message?.content ?? '',
      model:        res.model,
      inputTokens:  res.usage?.prompt_tokens     ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    }
  }

  async *stream(
    messages: ChatMessage[],
    options: AICompletionOptions = {},
  ): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model:       this.model,
      messages,
      max_tokens:  options.maxTokens  ?? 500,
      temperature: options.temperature ?? 0.7,
      stream:      true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }
}

// Module-level singletons — one client per model
export const gpt4oMini = new OpenAIProvider('gpt-4o-mini')
export const gpt4o     = new OpenAIProvider('gpt-4o')
