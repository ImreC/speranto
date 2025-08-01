export interface LLMGenerateOptions {
  temperature?: number
  maxTokens?: number
  topP?: number
  topK?: number
  [key: string]: any
}

export interface LLMResponse {
  content: string
  model: string
  finishReason?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export abstract class LLMInterface {
  protected model: string

  constructor(model: string) {
    this.model = model
  }

  abstract generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse>

  abstract isModelLoaded(): Promise<boolean>
}
