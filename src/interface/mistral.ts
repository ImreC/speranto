import { Mistral } from '@mistralai/mistralai'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

export class MistralProvider extends LLMInterface {
  private client: Mistral

  constructor(model: string, apiKey?: string) {
    super(model)
    const key = apiKey || process.env.LLM_API_KEY
    if (!key) {
      throw new Error(
        'Mistral API key is required. Set LLM_API_KEY environment variable or pass it to the constructor.',
      )
    }
    this.client = new Mistral({
      apiKey: key,
    })
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    await this.ensureModelReady()

    const completion = await this.client.chat.complete({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature ?? 0.7,
      ...options,
    })

    const choice = completion.choices[0]

    if (choice) {
      return {
        content: (choice.message.content as string) || '',
        model: completion.model,
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
      const modelNames = models?.data?.map((m) => m.name)
      return modelNames?.some((m) => m === this.model) || false
    } catch (error) {
      console.error('Error checking Mistral models:', error)
      return false
    }
  }

  async ensureModelReady(): Promise<void> {
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
