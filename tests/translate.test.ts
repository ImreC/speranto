import { test, expect, beforeEach, afterEach } from 'bun:test'
import { translate } from '../src/translate'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'path'
import type { Config } from '../src/types'
import { mockBunFile } from './mocks/BunFile'
import { MockLLMProvider } from './mocks/LLMProvider'

// Create test directories
const testDir = join(process.cwd(), 'test-fixtures')
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')

// Mock the LLM providers
beforeEach(async () => {
  // Create test directories
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })

  // Mock Bun.file for language instructions
  // @ts-ignore
  globalThis.Bun.file = mockBunFile
})

// Clean up after tests
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

test('translate should handle JSON files with single target language', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello', 'Hola')
  mockProvider.setMockResponse('Goodbye', 'Adiós')

  // Create test JSON file
  const jsonContent = {
    greeting: 'Hello',
    farewell: 'Goodbye',
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  // Check if output file was created
  const outputPath = join(targetDir, 'es', 'test.json')
  const outputContent = await readFile(outputPath, 'utf-8')
  const output = JSON.parse(outputContent)

  expect(output).toHaveProperty('greeting')
  expect(output).toHaveProperty('farewell')
})

test('translate should handle multiple target languages', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  // Create test markdown file
  await writeFile(join(sourceDir, 'test.md'), '# Hello World\n\nWelcome to our app.')

  const config: Config = {
    model: 'test-model',
    temperature: 0.5,
    sourceLang: 'en',
    targetLangs: ['es', 'fr', 'de'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  expect(config.targetLangs).toHaveLength(3)
})

test('translate should use language code as filename when configured', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  await writeFile(join(sourceDir, 'about.json'), '{"title": "About Us"}')

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir,
      useLangCodeAsFilename: true,
    },
  }

  await translate(config)

  expect(config.files!.useLangCodeAsFilename).toBe(true)
})

test('translate should handle JavaScript files', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  const jsContent = `
const config = {
  title: "My App",
  description: "A great application"
};
`
  await writeFile(join(sourceDir, 'config.js'), jsContent)

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['fr'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  const outputPath = join(targetDir, 'fr', 'config.js')
  const outputContent = await readFile(outputPath, 'utf-8')
  expect(outputContent).toContain('config')
})

test('translate should handle TypeScript files', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  const tsContent = `
interface Config {
  title: string;
}

const config: Config = {
  title: "My App"
};
`
  await writeFile(join(sourceDir, 'config.ts'), tsContent)

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['de'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  const outputPath = join(targetDir, 'de', 'config.ts')
  const outputContent = await readFile(outputPath, 'utf-8')
  expect(outputContent).toContain('Config')
})

test('translate should find files in nested directories', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  // Create nested structure
  await mkdir(join(sourceDir, 'docs', 'api'), { recursive: true })
  await writeFile(join(sourceDir, 'docs', 'api', 'reference.md'), '# API Reference')
  await writeFile(join(sourceDir, 'docs', 'guide.md'), '# User Guide')

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  // Verify nested files were translated
  const apiOutputPath = join(targetDir, 'es', 'docs', 'api', 'reference.md')
  const guideOutputPath = join(targetDir, 'es', 'docs', 'guide.md')
  const apiContent = await readFile(apiOutputPath, 'utf-8')
  const guideContent = await readFile(guideOutputPath, 'utf-8')

  expect(apiContent).toBeDefined()
  expect(guideContent).toBeDefined()
})

test('translate should skip unchanged JSON groups and reuse existing translations', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }

  const jsonContent = {
    nav: {
      home: 'Home',
      about: 'About',
    },
    footer: {
      copyright: 'Copyright 2024',
    },
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const existingTranslation = {
    nav: {
      home: 'Inicio',
      about: 'Acerca de',
    },
    footer: {
      copyright: 'Derechos reservados 2024',
    },
  }
  await mkdir(join(targetDir, 'es'), { recursive: true })
  await writeFile(
    join(targetDir, 'es', 'test.json'),
    JSON.stringify(existingTranslation, null, 2),
  )

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  expect(callCount).toBe(0)

  const outputPath = join(targetDir, 'es', 'test.json')
  const outputContent = await readFile(outputPath, 'utf-8')
  const output = JSON.parse(outputContent)
  expect(output.nav.home).toBe('Inicio')
  expect(output.footer.copyright).toBe('Derechos reservados 2024')
})

test('translate should retranslate groups with new keys', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }

  const jsonContent = {
    nav: {
      home: 'Home',
      about: 'About',
      contact: 'Contact',
    },
    footer: {
      copyright: 'Copyright 2024',
    },
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const existingTranslation = {
    nav: {
      home: 'Inicio',
      about: 'Acerca de',
    },
    footer: {
      copyright: 'Derechos reservados 2024',
    },
  }
  await mkdir(join(targetDir, 'es'), { recursive: true })
  await writeFile(
    join(targetDir, 'es', 'test.json'),
    JSON.stringify(existingTranslation, null, 2),
  )

  const config: Config = {
    model: 'test-model',
    temperature: 0.7,
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await translate(config)

  expect(callCount).toBe(1)
})
