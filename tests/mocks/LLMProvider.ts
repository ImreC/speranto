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
    // Try multiple patterns to match different prompt formats
    let textToTranslate = ''
    
    // Pattern 1: Translate: "text" from
    let match = prompt.match(/Translate: "(.*)" from/)
    if (match) {
      textToTranslate = match[1] as string
    } else {
      // Pattern 2: Translate the following ... from X to Y:\n\n<content>
      match = prompt.match(/Translate the following .* from \w+ to \w+:\n\n([\s\S]+?)(?:\n\nThis is a complete|$)/)
      if (match) {
        textToTranslate = match[1] as string
      }
    }

    // Return a mock translation
    const mockTranslation =
      this.mockResponses.get(textToTranslate.trim()) || `[Translated: ${textToTranslate}]`

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
