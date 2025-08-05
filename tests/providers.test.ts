import { test, expect, beforeEach } from 'bun:test'
import { Translator } from '../src/translator'
import { type LLMResponse, type LLMGenerateOptions } from '../src/interface'
import { MockLLMProvider } from './mocks/LLMProvider'
import { mockBunFile } from './mocks/BunFile'

beforeEach(() => {
  // @ts-ignore
  globalThis.Bun.file = mockBunFile
})

test('Translator should work with mocked LLM provider', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')

  // @ts-ignore - Inject mock provider
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'es',
    provider: 'mistral',
  })

  // @ts-ignore - Replace the llm with our mock
  translator.llm = mockProvider

  const result = await translator.translateText('Hello World')
  expect(result).toBe('Hola Mundo')
})

test('Translator should handle empty text', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  // @ts-ignore
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'fr',
    provider: 'mistral',
  })

  // @ts-ignore
  translator.llm = mockProvider

  const result = await translator.translateText('  ')
  expect(result).toBe('  ')
})

test('Translator should handle LLM errors gracefully', async () => {
  const mockProvider = new MockLLMProvider('test-model', true)

  // @ts-ignore
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'de',
    provider: 'mistral',
  })

  // @ts-ignore
  translator.llm = mockProvider

  expect(async () => {
    await translator.translateText('Hello')
  }).toThrow('Mock LLM error')
})

test('Translator should wait for model to be loaded', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setModelLoaded(false)

  // @ts-ignore
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'it',
    provider: 'mistral',
  })

  // @ts-ignore
  translator.llm = mockProvider

  // Start translation
  const translationPromise = translator.translateText('Test')

  // Model not loaded yet
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Now set model as loaded
  mockProvider.setModelLoaded(true)

  // Translation should complete
  const result = await translationPromise
  expect(result).toContain('[Translated: Test]')
})

test('Translator should include language instructions in prompt', async () => {
  let capturedPrompt = ''

  class CapturingMockProvider extends MockLLMProvider {
    override async generate(
      prompt: string,
      options?: LLMGenerateOptions,
    ): Promise<LLMResponse> {
      capturedPrompt = prompt
      return super.generate(prompt, options)
    }
  }

  // Mock language instructions file
  // @ts-ignore
  globalThis.Bun.file = (path: string) => ({
    exists: async () => path.includes('es.md'),
    text: async () => 'Use informal tone for Spanish translations.',
  })

  const mockProvider = new CapturingMockProvider('test-model')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.5,
    sourceLang: 'en',
    targetLang: 'es',
    provider: 'mistral',
  })

  // @ts-ignore
  translator.llm = mockProvider

  await translator.translateText('Hello')

  expect(capturedPrompt).toContain('Use informal tone for Spanish translations')
})

test.only('Translator should handle chunk translation with context', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('# Title', '# Título')

  // @ts-ignore
  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'es',
    provider: 'mistral',
  })

  // @ts-ignore
  translator.llm = mockProvider

  const chunk = {
    text: '# Title',
    context: 'section',
    nodes: [],
    startIndex: 0,
    endIndex: 0,
  }

  const result = await translator.translateChunk(chunk)
  expect(result).toContain('Título')
})
