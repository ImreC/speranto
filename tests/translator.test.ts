import { test, expect } from 'vitest'
import { Translator } from '../src/translator'
import { MockLLMProvider } from './mocks/LLMProvider'
import type { LLMGenerateOptions, LLMResponse } from '../src/interface'

test('should create translator instance', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  const translator = new Translator({
    model: 'test-model',
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
    sourceLang: 'en',
    targetLang: 'fr',
    llm: mockProvider,
  })

  const result = await translator.translateText('  ')
  expect(result).toBe('  ')
})

test('should reject group responses with missing or non-string values', async () => {
  class InvalidGroupProvider extends MockLLMProvider {
    override async generate(
      _prompt: string,
      _options?: LLMGenerateOptions,
    ): Promise<LLMResponse> {
      return { content: '{"title": 42}', model: 'test-model' }
    }
  }

  const translator = new Translator({
    model: 'test-model',
    sourceLang: 'en',
    targetLang: 'es',
    llm: new InvalidGroupProvider('test-model'),
  })

  await expect(
    translator.translateGroup('_root', [{ key: 'title', value: 'Title' }]),
  ).rejects.toThrow('missing a string value for key "title"')
})

test('should extract string values from wrapped group response values', async () => {
  class WrappedGroupProvider extends MockLLMProvider {
    override async generate(
      _prompt: string,
      _options?: LLMGenerateOptions,
    ): Promise<LLMResponse> {
      return { content: '{"title": {"value": "Título"}}', model: 'test-model' }
    }
  }

  const translator = new Translator({
    model: 'test-model',
    sourceLang: 'en',
    targetLang: 'es',
    llm: new WrappedGroupProvider('test-model'),
  })

  await expect(
    translator.translateGroup('_root', [{ key: 'title', value: 'Title' }]),
  ).resolves.toEqual([{ key: 'title', value: 'Título' }])
})
