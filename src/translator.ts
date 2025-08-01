import { join } from 'path'
import { LLMInterface, OllamaProvider, OpenAIProvider } from './interface'
import type { TranslatableChunk } from './parser'

interface TranslatorOptions {
  model: string
  temperature: number
  sourceLang: string
  targetLang: string
  provider?: 'ollama' | 'openai'
  apiKey?: string
}

export class Translator {
  private options: TranslatorOptions
  private languageInstructions: string | null = null
  private llm: LLMInterface
  private isModelReady: Promise<boolean>

  constructor(options: TranslatorOptions) {
    this.options = options
    this.llm = this.createLLMProvider()
    this.isModelReady = this.llm.isModelLoaded()
    this.loadLanguageInstructions()
  }

  private createLLMProvider(): LLMInterface {
    const provider = this.options.provider || 'ollama'

    switch (provider) {
      case 'openai':
        return new OpenAIProvider(this.options.model, this.options.apiKey)
      case 'ollama':
      default:
        return new OllamaProvider(this.options.model)
    }
  }

  private async loadLanguageInstructions(): Promise<void> {
    try {
      const instructionsPath = join(
        process.cwd(),
        'instructions',
        `${this.options.targetLang}.md`,
      )
      const file = Bun.file(instructionsPath)
      if (await file.exists()) {
        this.languageInstructions = await file.text()
        console.log(`Loaded language instructions for ${this.options.targetLang}`)
      } else {
        console.log(`No specific instructions found for ${this.options.targetLang}`)
      }
    } catch (error) {
      console.error(
        `Error loading language instructions for ${this.options.targetLang}:`,
        error,
      )
    }
  }

  async translateText(text: string): Promise<string> {
    if (!text.trim()) return text
    console.log('Awaiting model to be ready')
    await this.isModelReady
    console.log('Model ready. Starting translation')

    try {
      let prompt = `Translate: "${text}" from ${this.options.sourceLang} to ${this.options.targetLang}.`

      if (this.languageInstructions) {
        prompt += `\n\nFollow these language-specific guidelines:\n${this.languageInstructions}`
      }

      prompt += `\n\nRespond with only the translation.`

      const response = await this.llm.generate(prompt, {
        temperature: this.options.temperature,
      })
      console.log(`Translated to ${this.options.targetLang}`)
      return response.content
    } catch (error) {
      console.error(`Translation error for text: "${text}"`, error)
      throw error
    }
  }

  async translateChunk(chunk: TranslatableChunk): Promise<string> {
    if (!chunk.text.trim()) return chunk.text
    console.log(`Translating chunk with context: ${chunk.context || 'text'}`)
    await this.isModelReady

    try {
      let prompt = `Translate the following ${chunk.context || 'text'} from ${
        this.options.sourceLang
      } to ${this.options.targetLang}:\n\n${chunk.text}`

      if (this.languageInstructions) {
        prompt += `\n\nFollow these language-specific guidelines:\n${this.languageInstructions}`
      }

      // Add context-specific instructions
      if (chunk.context === 'code') {
        prompt += `\n\nThis is a code block. Only translate comments and documentation strings, not the code itself.`
      } else if (chunk.context === 'list-with-context') {
        prompt += `\n\nThis is a list with surrounding context. Maintain the list structure and ensure the translation flows naturally with the context.`
      } else if (chunk.context === 'section') {
        prompt += `\n\nThis is a complete section. Ensure consistency in terminology throughout the section.`
      }

      prompt += `\n\nProvide only the translated content, maintaining the exact same markdown formatting and structure.`

      const response = await this.llm.generate(prompt, {
        temperature: this.options.temperature,
      })

      return response.content
    } catch (error) {
      console.error(`Translation error for chunk with context "${chunk.context}":`, error)
      throw error
    }
  }
}
