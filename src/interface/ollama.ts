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
      console.log(`Available models: \n---\n${modelNames.join('\n')}\n---`)
      return modelNames.some((m) => m.includes(this.model))
    } catch (error) {
      console.error('Error checking Ollama models:', error)
      return false
    }
  }

  async isModelLoaded(): Promise<boolean> {
    const isAvailable = await this.isModelAvailable()

    if (isAvailable) {
      console.log(`Model ${this.model} available`)
      return true
    }

    console.log(`Model ${this.model} not found locally. Pulling from Ollama...`)

    try {
      const stream = await ollama.pull({
        model: this.model,
        stream: true,
      })
      let message = ''

      for await (const progress of stream) {
        // Log progress to console as well
        let newMessage
        const percentage = Math.round((progress.completed / progress.total) * 100)
        newMessage = `Pulling ${this.model}: ${progress.status}`
        if (progress.total > 0 && !isNaN(percentage)) {
          newMessage += ` - ${percentage}%`
        }
        if (newMessage !== message) {
          console.log(newMessage)
          message = newMessage
        }
      }

      console.log(`Model ${this.model} pulled successfully`)
      return true
    } catch (error) {
      console.error(`Error pulling model ${this.model}:`, error)
      throw new Error(`Failed to pull model ${this.model}: ${error}`)
    }
  }
}
