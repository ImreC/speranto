import { test, expect } from 'bun:test'
import { Translator } from '../src/translator'
import { MockLLMProvider } from './mocks/LLMProvider'

test('should create translator instance', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'es',
    llm: mockProvider,
  })

  expect(translator).toBeDefined()
})

test('should handle empty text', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'fr',
    llm: mockProvider,
  })

  const result = await translator.translateText('  ')
  expect(result).toBe('  ')
})
