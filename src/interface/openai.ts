import OpenAI from 'openai'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

export class OpenAIProvider extends LLMInterface {
  private client: OpenAI
  private modelChecked: boolean = false

  constructor(model: string, apiKey?: string) {
    super(model)
    const key = apiKey || process.env.LLM_API_KEY
    if (!key) {
      throw new Error(
        'OpenAI API key is required. Set LLM_API_KEY environment variable or pass it to the constructor.',
      )
    }
    this.client = new OpenAI({
      apiKey: key,
    })
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    if (!this.modelChecked) {
      await this.ensureModelReady()
      this.modelChecked = true
    }

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      ...options,
    })

    const choice = completion.choices[0]
    if (choice) {
      return {
        content: choice.message.content || '',
        model: completion.model,
        finishReason: choice.finish_reason || undefined,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
      }
    }
    return {
      content: '',
      model: completion.model,
    }
  }

  async isModelAvailable(): Promise<boolean> {
    try {
      console.log(`Checking OpenAI model availability for ${this.model}...`)
      const startTime = Date.now()
      const models = await this.client.models.list()
      const elapsed = Date.now() - startTime
      console.log(`OpenAI models list fetched in ${elapsed}ms`)
      return models.data.some((m) => m.id === this.model)
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        console.error('OpenAI API key is invalid or missing')
        return false
      }
      console.error('Error checking OpenAI models:', error)
      return false
    }
  }

  async ensureModelReady(): Promise<void> {
    if (!this.client.apiKey) {
      throw new Error(
        'OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it to the constructor.',
      )
    }

    const isAvailable = await this.isModelAvailable()
    if (!isAvailable) {
      console.warn(
        `Model ${this.model} may not be available or you don't have access to it. Proceeding anyway...`,
      )
    }
  }

  async isModelLoaded(): Promise<boolean> {
    const isAvailable = await this.isModelAvailable()

    return isAvailable
  }
}
