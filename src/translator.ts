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
  instructionsDir?: string
  retranslate?: boolean
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
      const baseDir = this.options.instructionsDir || join(process.cwd(), 'instructions')
      const instructionsPath = join(baseDir, `${this.options.targetLang}.md`)
      if (existsSync(instructionsPath)) {
        this.languageInstructions = await readFile(instructionsPath, 'utf-8')
      }
    } catch {
      // Ignore errors loading instructions
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
    await this.isModelReady

    const response = await this.llm.generate(this.constructPrompt(text), {
      temperature: this.options.temperature,
    })
    return response.content
  }

  async translateChunk(chunk: TranslatableChunk): Promise<string> {
    if (!chunk.text.trim()) return chunk.text
    await this.isModelReady

    const response = await this.llm.generate(this.constructPrompt(chunk.text, chunk.context), {
      temperature: this.options.temperature,
    })

    return response.content
  }

  async translateGroup(
    groupKey: string,
    strings: Array<{ key: string; value: string }>,
  ): Promise<Array<{ key: string; value: string }>> {
    if (strings.length === 0) return strings
    await this.isModelReady

    const jsonInput = Object.fromEntries(strings.map(({ key, value }) => [key, value]))

    const prompt = this.constructGroupPrompt(groupKey, jsonInput)

    const response = await this.llm.generate(prompt, {
      temperature: this.options.temperature,
    })

    return this.parseGroupResponse(response.content, strings)
  }

  private constructGroupPrompt(groupKey: string, jsonInput: Record<string, string>): string {
    let prompt =
      'You are a professional translator who is going to be asked to translate a JSON object containing related text strings. '

    if (this.languageInstructions) {
      prompt += `\n\nYou are following these language-specific guidelines:\n${this.languageInstructions}`
    }

    prompt += `\n\nThese strings belong to the "${groupKey}" section/page of an application. Ensure consistency in terminology and style across all strings in this group.`

    prompt += `\n\nYou MUST translate ALL values without exception. Do not skip any values, including slugs or identifiers while being mindfull of words typically borrowed from other languages. Keep it how it is common to do in ${this.options.targetLang}`

    if (!this.options.retranslate) {
      prompt += ` However, if a value appears to already be translated into ${this.options.targetLang}, keep it as-is.`
    }

    prompt += `\n\nYou maintain the original JSON structure exactly. You respond with valid JSON only, no additional text or explanation.`

    prompt += `\n\nTranslate the following JSON from ${this.options.sourceLang} to ${
      this.options.targetLang
    }:\n\n${JSON.stringify(jsonInput, null, 2)}`

    return prompt
  }

  private parseGroupResponse(
    response: string,
    originalStrings: Array<{ key: string; value: string }>,
  ): Array<{ key: string; value: string }> {
    let cleaned = response.trim()
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7)
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3)
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3)
    }
    cleaned = cleaned.trim()

    try {
      const parsed = JSON.parse(cleaned) as Record<string, string>
      return originalStrings.map(({ key }) => ({
        key,
        value: parsed[key] ?? originalStrings.find((s) => s.key === key)?.value ?? '',
      }))
    } catch {
      console.warn(
        'Failed to parse group translation response as JSON, falling back to individual translations',
      )
      return originalStrings
    }
  }
}
