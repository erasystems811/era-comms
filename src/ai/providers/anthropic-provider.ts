import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../shared/config.js'
import type {
  IAIProvider,
  ChatMessage,
  AICompletionOptions,
  AICompletionResult,
} from '../../interfaces/ai.js'

export class AnthropicProvider implements IAIProvider {
  private readonly client: Anthropic
  readonly providerId: string

  constructor(private readonly model: string) {
    this.providerId = `anthropic/${model}`
    this.client     = new Anthropic({ apiKey: config.ai.anthropicApiKey })
  }

  // Anthropic's API separates the system prompt from the turn list.
  // Extract the first system-role message; everything else is turns.
  private splitMessages(messages: ChatMessage[]): {
    system:  string | undefined
    turns:   Array<{ role: 'user' | 'assistant'; content: string }>
  } {
    const first  = messages[0]
    const system = first?.role === 'system' ? first.content : undefined
    const turns  = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    return { system, turns }
  }

  async complete(
    messages: ChatMessage[],
    options: AICompletionOptions = {},
  ): Promise<AICompletionResult> {
    const { system, turns } = this.splitMessages(messages)

    const res = await this.client.messages.create({
      model:      this.model,
      system,
      messages:   turns,
      max_tokens: options.maxTokens ?? 500,
    })

    const block = res.content[0]
    return {
      content:      block?.type === 'text' ? block.text : '',
      model:        res.model,
      inputTokens:  res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    }
  }

  async *stream(
    messages: ChatMessage[],
    options: AICompletionOptions = {},
  ): AsyncIterable<string> {
    const { system, turns } = this.splitMessages(messages)

    const stream = this.client.messages.stream({
      model:      this.model,
      system,
      messages:   turns,
      max_tokens: options.maxTokens ?? 500,
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text
      }
    }
  }
}

// claude-sonnet-4-6 is the current Sonnet model ID
export const claudeSonnet = new AnthropicProvider('claude-sonnet-4-6')
