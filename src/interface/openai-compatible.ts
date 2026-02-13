import OpenAI from 'openai'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434/v1',
}

export class OpenAICompatibleProvider extends LLMInterface {
  private client: OpenAI

  constructor(
    model: string,
    options: { apiKey?: string; baseUrl?: string; provider?: string } = {},
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

    this.client = new OpenAI({ apiKey: apiKey || '', baseURL })
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
    })

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
