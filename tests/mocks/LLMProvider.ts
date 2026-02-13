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

    // Check if this is a JSON group translation prompt
    if (prompt.includes('respond with valid JSON only')) {
      const jsonMatch = prompt.match(/Translate the following JSON[^:]*:\n\n([\s\S]+?)$/)
      if (jsonMatch) {
        try {
          const inputJson = JSON.parse(jsonMatch[1]!)
          const outputJson: Record<string, string> = {}
          for (const [key, value] of Object.entries(inputJson)) {
            const mockValue = this.mockResponses.get(String(value))
            outputJson[key] = mockValue ?? `[Translated: ${value}]`
          }
          return {
            content: JSON.stringify(outputJson, null, 2),
            model: this.model,
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          }
        } catch {
          // Fall through to default handling
        }
      }
    }

    // Extract the text to translate from the prompt
    let textToTranslate = ''

    let match = prompt.match(/Translate: "(.*)" from/)
    if (match) {
      textToTranslate = match[1] as string
    } else {
      match = prompt.match(
        /Translate the following .* from \w+ to \w+:\n\n([\s\S]+?)(?:\n\nThis is a complete|$)/,
      )
      if (match) {
        textToTranslate = match[1] as string
      }
    }

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
