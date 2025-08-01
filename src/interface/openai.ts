import OpenAI from 'openai'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

export class OpenAIProvider extends LLMInterface {
  private client: OpenAI

  constructor(model: string, apiKey?: string) {
    super(model)
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    })
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    await this.ensureModelReady()

    const completion = await this.client.completions.create({
      model: this.model,
      prompt,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      ...options,
    })

    const choice = completion.choices[0]
    if (choice) {
      return {
        content: choice.text.trim(),
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
      const models = await this.client.models.list()
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
    // OpenAI models are cloud-based and don't require local download
    // We just check if the model is available
    const isAvailable = await this.isModelAvailable()

    return isAvailable
  }
}
