import { join } from 'path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { LLMInterface, OllamaProvider, OpenAIProvider, MistralProvider } from './interface'
import type { TranslatableChunk } from './parsers/md'

interface TranslatorOptions {
  model: string
  temperature: number
  sourceLang: string
  targetLang: string
  provider?: 'ollama' | 'openai' | 'mistral'
  apiKey?: string
  llm?: LLMInterface
}

export class Translator {
  private options: TranslatorOptions
  private languageInstructions: string | null = null
  private llm: LLMInterface
  private isModelReady: Promise<boolean>

  constructor(options: TranslatorOptions) {
    this.options = options
    this.llm = options.llm ?? this.createLLMProvider()
    this.isModelReady = this.llm.isModelLoaded()
    this.loadLanguageInstructions()
  }

  private createLLMProvider(): LLMInterface {
    const provider = this.options.provider || 'ollama'
    console.log(`Using ${provider} provider`)

    switch (provider) {
      case 'openai':
        return new OpenAIProvider(this.options.model, this.options.apiKey)
      case 'mistral':
        return new MistralProvider(this.options.model, this.options.apiKey)
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
      if (existsSync(instructionsPath)) {
        this.languageInstructions = await readFile(instructionsPath, 'utf-8')
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

  private constructPrompt(text: string, context: string | undefined = undefined) {
    let prompt =
      'You are a professional translator who is going to be asked to translate a text. '

    if (this.languageInstructions) {
      prompt += `\n\You are following these language-specific guidelines:\n${this.languageInstructions}`
    }
    // Add context-specific instructions
    if (context === 'code') {
      prompt += `\n\The text is a code block. Only translate comments and documentation strings, not the code itself.`
    } else if (context === 'list-with-context') {
      prompt += `\n\The text is a list with surrounding context. Maintain the list structure and ensure the translation flows naturally with the context.`
    } else if (context === 'section') {
      prompt += `\n\The text is a complete section. Ensure consistency in terminology throughout the section.`
    }

    prompt += `\n\nYou maintain the original structure and formatting exactly. You respond with the translation and the translation only.`

    prompt += `\n\nTranslate the following text from ${this.options.sourceLang} to ${this.options.targetLang}:\n\n${text}`

    return prompt
  }

  async translateText(text: string): Promise<string> {
    if (!text.trim()) return text
    console.log('Awaiting model to be ready')
    await this.isModelReady
    console.log('Model ready. Starting translation')

    try {
      const response = await this.llm.generate(this.constructPrompt(text), {
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
      const response = await this.llm.generate(
        this.constructPrompt(chunk.text, chunk.context),
        {
          temperature: this.options.temperature,
        },
      )

      return response.content
    } catch (error) {
      console.error(`Translation error for chunk with context "${chunk.context}":`, error)
      throw error
    }
  }
}
