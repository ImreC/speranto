import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'path'
import { Translator } from '../src/translator'
import { type LLMResponse, type LLMGenerateOptions } from '../src/interface'
import { MockLLMProvider } from './mocks/LLMProvider'

const instructionsDir = join(process.cwd(), 'instructions')
const esInstructionsFile = join(instructionsDir, 'es.md')

beforeAll(() => {
  if (!existsSync(instructionsDir)) {
    mkdirSync(instructionsDir, { recursive: true })
  }
  writeFileSync(esInstructionsFile, 'Use informal tone for Spanish translations.')
})

afterAll(() => {
  if (existsSync(esInstructionsFile)) {
    rmSync(esInstructionsFile)
  }
})

test('Translator should work with mocked LLM provider', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'es',
    llm: mockProvider,
  })

  const result = await translator.translateText('Hello World')
  expect(result).toBe('Hola Mundo')
})

test('Translator should handle empty text', async () => {
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

test('Translator should handle LLM errors gracefully', async () => {
  const mockProvider = new MockLLMProvider('test-model', true)

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'de',
    llm: mockProvider,
  })

  expect(async () => {
    await translator.translateText('Hello')
  }).toThrow('Mock LLM error')
})

test('Translator should wait for model to be loaded', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'it',
    llm: mockProvider,
  })

  const result = await translator.translateText('Test')
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

  const mockProvider = new CapturingMockProvider('test-model')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.5,
    sourceLang: 'en',
    targetLang: 'es',
    llm: mockProvider,
  })

  await new Promise((resolve) => setTimeout(resolve, 50))

  await translator.translateText('Hello')

  expect(capturedPrompt).toContain('Use informal tone for Spanish translations')
})

test('Translator should handle chunk translation with context', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('# Title', '# Título')

  const translator = new Translator({
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLang: 'es',
    llm: mockProvider,
  })

  const chunk = {
    text: '# Title',
    context: 'section',
    nodes: [],
    startIndex: 0,
    endIndex: 0,
  }

  const result = await translator.translateChunk(chunk)
  expect(result).toContain('# Título')
})
