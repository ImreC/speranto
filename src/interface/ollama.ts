import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'
import type { OllamaConfig } from '../config'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_TIMEOUT = 600_000
const modelInitializations = new Map<string, Promise<boolean>>()

interface OllamaModel {
  name?: string
  model?: string
}

interface OllamaTagsResponse {
  models?: OllamaModel[]
}

interface OllamaChatResponse {
  model?: string
  message?: {
    content?: string
  }
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OllamaProviderOptions {
  apiKey?: string
  baseUrl?: string
  timeout?: number
  ollama?: OllamaConfig
  fetch?: Fetch
}

export class OllamaProvider extends LLMInterface {
  private baseUrl: string
  private apiKey?: string
  private timeout: number
  private ollama: OllamaConfig
  private fetch: Fetch
  private modelLoaded?: Promise<boolean>

  constructor(model: string, options: OllamaProviderOptions = {}) {
    super(model)
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.apiKey = options.apiKey
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT
    this.ollama = options.ollama ?? {}
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    const response = await this.request<OllamaChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: options?.output === 'json' ? 'json' : undefined,
        keep_alive: this.ollama.keepAlive,
        options: {
          num_predict: options?.maxTokens,
          num_ctx: this.ollama.contextLength,
          temperature: this.ollama.temperature,
        },
      }),
    })

    const promptTokens = response.prompt_eval_count
    const completionTokens = response.eval_count

    return {
      content: response.message?.content ?? '',
      model: response.model ?? this.model,
      finishReason: response.done_reason,
      usage:
        promptTokens !== undefined || completionTokens !== undefined
          ? {
              promptTokens,
              completionTokens,
              totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
            }
          : undefined,
    }
  }

  isModelLoaded(): Promise<boolean> {
    if (this.modelLoaded) return this.modelLoaded

    const cacheKey = `${this.baseUrl}:${this.model}:${this.ollama.autoPull === true}`
    const existing = modelInitializations.get(cacheKey)
    if (existing) {
      this.modelLoaded = existing
      return existing
    }

    const initialization = this.ensureModelLoaded().catch((error) => {
      modelInitializations.delete(cacheKey)
      throw error
    })
    modelInitializations.set(cacheKey, initialization)
    this.modelLoaded = initialization
    return this.modelLoaded
  }

  private async ensureModelLoaded(): Promise<boolean> {
    await this.request('/api/version')
    const tags = await this.request<OllamaTagsResponse>('/api/tags')
    if (tags.models?.some((model) => matchesModel(this.model, model.name ?? model.model))) {
      return true
    }

    if (!this.ollama.autoPull) {
      throw new Error(
        `Ollama model "${this.model}" is not installed. Run: ollama pull ${this.model}`,
      )
    }

    await this.request('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ model: this.model, stream: false }),
    })
    return true
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    if (this.apiKey) headers.set('authorization', `Bearer ${this.apiKey}`)

    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(
          `Ollama request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`,
        )
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${this.timeout}ms`)
      }
      if (error instanceof TypeError) {
        throw new Error(
          `Could not connect to Ollama at ${this.baseUrl}. Install or start Ollama and retry.`,
          { cause: error },
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function matchesModel(requested: string, installed?: string): boolean {
  if (!installed) return false
  if (requested === installed) return true
  if (!requested.includes(':')) return installed === `${requested}:latest`
  return false
}
