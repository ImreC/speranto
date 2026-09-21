import OpenAI from 'openai'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434/v1',
}

const INITIAL_RETRY_DELAY_MS = 60_000
const MAX_RETRIES = 5
const MAX_RETRY_DELAY_MS = 5 * 60_000
const INITIAL_TRANSIENT_RETRY_DELAY_MS = 1_000
const MAX_TRANSIENT_RETRY_DELAY_MS = 30_000

export interface RateLimitHandler {
  onRateLimit(retryIn: number, attempt: number): void
  onFatal?(error: Error): void
}

export class OpenAICompatibleProvider extends LLMInterface {
  private client: OpenAI
  private consecutiveRateLimits = 0
  private rateLimitHandler?: RateLimitHandler
  private initialRetryDelayMs: number
  private maxRetryDelayMs: number
  private modelLoaded?: Promise<boolean>

  constructor(
    model: string,
    options: {
      apiKey?: string
      baseUrl?: string
      provider?: string
      timeout?: number
      rateLimitHandler?: RateLimitHandler
    } = {},
  ) {
    super(model)

    const defaultBaseURL = PROVIDER_BASE_URLS.openai || 'https://api.openai.com/v1'
    const providerBaseURL = options.provider ? PROVIDER_BASE_URLS[options.provider] : undefined
    const baseURL = options.baseUrl ?? providerBaseURL ?? defaultBaseURL

    const isOllama = baseURL.includes('localhost:11434') || baseURL.includes('127.0.0.1:11434')
    const apiKey = isOllama ? 'ollama' : (options.apiKey || process.env.LLM_API_KEY)
    this.initialRetryDelayMs = isOllama ? 1_000 : INITIAL_RETRY_DELAY_MS
    this.maxRetryDelayMs = isOllama ? 10_000 : MAX_RETRY_DELAY_MS

    if (!apiKey && !isOllama) {
      throw new Error(
        'API key is required. Set LLM_API_KEY environment variable or pass apiKey in config.',
      )
    }

    this.client = new OpenAI({
      apiKey: apiKey || '',
      baseURL,
      maxRetries: 0,
      timeout: options.timeout,
    })
    this.rateLimitHandler = options.rateLimitHandler
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: options?.maxTokens,
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
          const retryAfter = getRetryAfterMs(err)
          const exponentialDelay = Math.min(
            this.initialRetryDelayMs * 2 ** (this.consecutiveRateLimits - 1),
            this.maxRetryDelayMs,
          )
          const delay = retryAfter ?? addJitter(exponentialDelay)
          this.rateLimitHandler?.onRateLimit(delay, this.consecutiveRateLimits)
          await sleep(delay)
          continue
        }
        if (isRetryableProviderError(err) && attempt < MAX_RETRIES) {
          const delay = addJitter(
            Math.min(
              INITIAL_TRANSIENT_RETRY_DELAY_MS * 2 ** attempt,
              MAX_TRANSIENT_RETRY_DELAY_MS,
            ),
          )
          await sleep(delay)
          continue
        }
        if (isFatalProviderError(err)) {
          this.rateLimitHandler?.onFatal?.(err)
        }
        throw err
      }
    }

    throw new Error('Unreachable')
  }

  isModelLoaded(): Promise<boolean> {
    this.modelLoaded ??= this.client.models
      .list()
      .then(() => true)
      .catch(() => true)
    return this.modelLoaded
  }
}

function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const status = 'status' in error ? error.status : undefined
  if (typeof status === 'number' && status >= 500) return true
  return error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError'
}

function isFatalProviderError(error: unknown): error is Error {
  return (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof OpenAI.NotFoundError
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function addJitter(delayMs: number): number {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4))
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('headers' in error)) return undefined

  const headers = error.headers
  if (typeof headers !== 'object' || headers === null || !('get' in headers)) return undefined
  if (typeof headers.get !== 'function') return undefined

  const value = headers.get('retry-after')
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.max(0, retryAt - Date.now())
}
