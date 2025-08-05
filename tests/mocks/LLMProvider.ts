import { LLMInterface, type LLMResponse, type LLMGenerateOptions } from '../../src/interface'

export class MockLLMProvider extends LLMInterface {
  private mockResponses: Map<string, string> = new Map()
  private modelLoaded: boolean = true

  constructor(model: string, private shouldFail: boolean = false) {
    super(model)
  }

  setMockResponse(prompt: string, response: string) {
    this.mockResponses.set(prompt, response)
  }

  setModelLoaded(loaded: boolean) {
    this.modelLoaded = loaded
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    if (this.shouldFail) {
      throw new Error('Mock LLM error')
    }
    console.log('PROMPT', prompt)

    // Extract the text to translate from the prompt
    const match = prompt.match(/Translate: "(.*)" from/)
    const textToTranslate = match ? (match[1] as string) : ''

    // Return a mock translation
    const mockTranslation =
      this.mockResponses.get(textToTranslate) || `[Translated: ${textToTranslate}]`

    return {
      content: mockTranslation,
      model: this.model,
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    }
  }

  async isModelLoaded(): Promise<boolean> {
    return this.modelLoaded
  }
}
