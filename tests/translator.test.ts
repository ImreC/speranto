import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Translator } from '../src/translator'

// Create mock LLM provider
class MockLLMProvider {
  async isModelLoaded() {
    return true
  }

  async generate() {
    return { content: 'translated text' }
  }
}

// Mock the Bun.file to avoid reading actual instruction files
const originalBunFile = Bun.file
beforeEach(() => {
  // @ts-ignore
  globalThis.Bun.file = (path: string) => ({
    exists: async () => false,
    text: async () => '',
  })
})

// Restore after tests
afterEach(() => {
  // @ts-ignore
  globalThis.Bun.file = originalBunFile
})

describe('translator', () => {
  it('should create translator instance', async () => {
    const translator = new Translator({
      model: 'test-model',
      temperature: 0.7,
      sourceLang: 'en',
      targetLang: 'es',
      provider: 'ollama',
    })

    expect(translator).toBeDefined()
  })

  it('should handle empty text', async () => {
    const translator = new Translator({
      model: 'test-model',
      temperature: 0.7,
      sourceLang: 'en',
      targetLang: 'fr',
    })

    const result = await translator.translateText('  ')
    expect(result).toBe('  ')
  })
})
