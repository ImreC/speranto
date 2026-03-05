import OpenAI from 'openai'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434/v1',
}

const INITIAL_RETRY_DELAY_MS = 60_000
const MAX_RETRIES = 5

export interface RateLimitHandler {
  onRateLimit(retryIn: number, attempt: number): void
}

export class OpenAICompatibleProvider extends LLMInterface {
  private client: OpenAI
  private consecutiveRateLimits = 0
  private rateLimitHandler?: RateLimitHandler

  constructor(
    model: string,
    options: { apiKey?: string; baseUrl?: string; provider?: string; rateLimitHandler?: RateLimitHandler } = {},
  ) {
    super(model)

    const baseURL =
      options.baseUrl ??
      (options.provider ? PROVIDER_BASE_URLS[options.provider] : undefined) ??
      PROVIDER_BASE_URLS.openai

    const isOllama = baseURL.includes('localhost:11434') || baseURL.includes('127.0.0.1:11434')
    const apiKey = isOllama ? 'ollama' : (options.apiKey || process.env.LLM_API_KEY)

    if (!apiKey && !isOllama) {
      throw new Error(
        'API key is required. Set LLM_API_KEY environment variable or pass apiKey in config.',
      )
    }

    this.client = new OpenAI({ apiKey: apiKey || '', baseURL, maxRetries: 0 })
    this.rateLimitHandler = options.rateLimitHandler
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens,
          top_p: options?.topP,
        })

        this.consecutiveRateLimits = 0

        const choice = completion.choices[0]
        return {
          content: choice?.message.content || '',
          model: completion.model,
          finishReason: choice?.finish_reason || undefined,
          usage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens,
                completionTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              }
            : undefined,
        }
      } catch (err) {
        if (err instanceof OpenAI.RateLimitError && attempt < MAX_RETRIES) {
          this.consecutiveRateLimits++
          const delay = INITIAL_RETRY_DELAY_MS * this.consecutiveRateLimits
          this.rateLimitHandler?.onRateLimit(delay, this.consecutiveRateLimits)
          await sleep(delay)
          continue
        }
        throw err
      }
    }

    throw new Error('Unreachable')
  }

  async isModelLoaded(): Promise<boolean> {
    try {
      await this.client.models.list()
      return true
    } catch {
      return true
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
