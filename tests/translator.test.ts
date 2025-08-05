import { test, expect } from 'bun:test'
import { Translator } from '../src/translator'

test('should create translator instance', async () => {
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'es',
    provider: 'mistral',
  })

  expect(translator).toBeDefined()
})

test('should handle empty text', async () => {
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'fr',
    provider: 'mistral',
  })

  const result = await translator.translateText('  ')
  expect(result).toBe('  ')
})
