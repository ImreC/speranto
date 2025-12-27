import ollama from 'ollama'
import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'

export class OllamaProvider extends LLMInterface {
  constructor(model: string) {
    super(model)
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    const response = await ollama.generate({
      model: this.model,
      prompt,
      options: {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
        top_p: options?.topP,
        top_k: options?.topK,
        ...options,
      },
    })

    return {
      content: response.response.trim(),
      model: this.model,
      finishReason: response.done ? 'stop' : undefined,
      usage: response.eval_count
        ? {
            promptTokens: response.prompt_eval_count,
            completionTokens: response.eval_count,
            totalTokens: (response.prompt_eval_count || 0) + response.eval_count,
          }
        : undefined,
    }
  }

  async isModelAvailable(): Promise<boolean> {
    try {
      const models = await ollama.list()
      const modelNames = models.models.map((m) => m.name)
      return modelNames.some((m) => m.includes(this.model))
    } catch {
      return false
    }
  }

  async isModelLoaded(): Promise<boolean> {
    const isAvailable = await this.isModelAvailable()

    if (isAvailable) {
      return true
    }

    try {
      const stream = await ollama.pull({
        model: this.model,
        stream: true,
      })

      for await (const _progress of stream) {
        // Consume the stream
      }

      return true
    } catch (error) {
      throw new Error(`Failed to pull model ${this.model}: ${error}`)
    }
  }
}
