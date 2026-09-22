import { test, expect, beforeEach, afterEach } from 'vitest'
import { orchestrate } from '../src/orchestrate'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'path'
import type { Config } from '../src/types'
import { MockLLMProvider } from './mocks/LLMProvider'
import type { ExecutionEvent } from '../src/execution/events'

const testDir = join(process.cwd(), 'test-fixtures')
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  await rm(join(process.cwd(), '.speranto'), { recursive: true, force: true })
})

test('translate should handle JSON files with single target language', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello', 'Hola')
  mockProvider.setMockResponse('Goodbye', 'Adiós')

  const jsonContent = {
    greeting: 'Hello',
    farewell: 'Goodbye',
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  const outputPath = join(targetDir, 'es', 'test.json')
  const outputContent = await readFile(outputPath, 'utf-8')
  const output = JSON.parse(outputContent)

  expect(output).toHaveProperty('greeting')
  expect(output).toHaveProperty('farewell')
})

test('translate should handle multiple target languages', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  await writeFile(join(sourceDir, 'test.md'), '# Hello World\n\nWelcome to our app.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es', 'fr', 'de'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  expect(config.targetLangs).toHaveLength(3)
})

test('translate should share global concurrency across target languages', async () => {
  class ConcurrentMockProvider extends MockLLMProvider {
    activeCalls = 0
    maximumActiveCalls = 0

    override async generate(prompt: string, options?: any) {
      this.activeCalls++
      this.maximumActiveCalls = Math.max(this.maximumActiveCalls, this.activeCalls)
      try {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return await super.generate(prompt, options)
      } finally {
        this.activeCalls--
      }
    }
  }

  const mockProvider = new ConcurrentMockProvider('test-model')
  await writeFile(
    join(sourceDir, 'test.json'),
    JSON.stringify({ page: { title: 'Title' } }),
  )

  await orchestrate(
    {
      model: 'test-model',
      sourceLang: 'en',
      targetLangs: ['es', 'fr', 'de'],
      provider: 'mistral',
      concurrency: 2,
      llm: mockProvider,
      files: {
        sourceDir,
        targetDir: join(targetDir, '[lang]'),
      },
    },
    '0.1.2',
  )

  expect(mockProvider.maximumActiveCalls).toBe(2)
})

test('translate should report complete plans before translation starts', async () => {
  const events: ExecutionEvent[] = []
  await writeFile(
    join(sourceDir, 'pages.json'),
    JSON.stringify({ checkout: { title: 'Checkout' }, nav: { home: 'Home' } }),
  )

  await orchestrate(
    {
      model: 'test-model',
      sourceLang: 'en',
      targetLangs: ['es', 'fr'],
      provider: 'mistral',
      llm: new MockLLMProvider('test-model'),
      files: { sourceDir, targetDir: join(targetDir, '[lang]') },
    },
    '0.1.2',
    { handle: (event) => events.push(event) },
  )

  const planned = events.filter((event) => event.type === 'scope-planned')
  const planningCompleted = events.findIndex((event) => event.type === 'planning-completed')
  const firstTranslation = events.findIndex(
    (event) => event.type === 'job-started' && event.job.kind === 'translation',
  )

  expect(planned).toHaveLength(2)
  expect(planned.every((event) => event.type === 'scope-planned' && event.scope.jobs === 2)).toBe(
    true,
  )
  expect(planningCompleted).toBeGreaterThan(-1)
  expect(firstTranslation).toBeGreaterThan(planningCompleted)
})

test('translate should use language code as filename when configured', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  await writeFile(join(sourceDir, 'about.json'), '{"title": "About Us"}')

  const config: Config = {
    model: 'test-model',
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

  await orchestrate(config, '0.1.2')

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
    sourceLang: 'en',
    targetLangs: ['fr'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  const outputPath = join(targetDir, 'fr', 'config.js')
  const outputContent = await readFile(outputPath, 'utf-8')
  expect(outputContent).toContain('config')
})

test('translate should keep duplicate JavaScript property paths distinct', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('First title', 'Primer título')
  mockProvider.setMockResponse('Second title', 'Segundo título')

  const jsContent = `
export const first = { title: "First title" }
export const second = { title: "Second title" }
`
  await writeFile(join(sourceDir, 'messages.js'), jsContent)

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  const outputContent = await readFile(join(targetDir, 'es', 'messages.js'), 'utf-8')
  expect(outputContent).toContain('Primer título')
  expect(outputContent).toContain('Segundo título')
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
    sourceLang: 'en',
    targetLangs: ['de'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  const outputPath = join(targetDir, 'de', 'config.ts')
  const outputContent = await readFile(outputPath, 'utf-8')
  expect(outputContent).toContain('Config')
})

test('translate should find files in nested directories', async () => {
  const mockProvider = new MockLLMProvider('test-model')

  await mkdir(join(sourceDir, 'docs', 'api'), { recursive: true })
  await writeFile(join(sourceDir, 'docs', 'api', 'reference.md'), '# API Reference')
  await writeFile(join(sourceDir, 'docs', 'guide.md'), '# User Guide')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

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
  mockProvider.setMockResponse('Home', 'Inicio')
  mockProvider.setMockResponse('About', 'Acerca de')
  mockProvider.setMockResponse('Copyright 2024', 'Derechos reservados 2024')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')
  callCount = 0
  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(0)
})

test('translate should retranslate groups with new keys', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }

  const initialJsonContent = {
    nav: {
      home: 'Home',
      about: 'About',
    },
    footer: {
      copyright: 'Copyright 2024',
    },
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(initialJsonContent, null, 2))
  mockProvider.setMockResponse('Home', 'Inicio')
  mockProvider.setMockResponse('About', 'Acerca de')
  mockProvider.setMockResponse('Copyright 2024', 'Derechos reservados 2024')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

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
  callCount = 0

  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(1)
})

test('translate should restore markdown output from sidecar state without retranslating', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse(
    '# Hello World\n\nWelcome to our app.',
    '# Hola Mundo\n\nBienvenido a nuestra app.',
  )

  await writeFile(join(sourceDir, 'test.md'), '# Hello World\n\nWelcome to our app.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  await rm(join(targetDir, 'es', 'test.md'))
  callCount = 0

  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(0)
  expect(existsSync(join(targetDir, 'es', 'test.md'))).toBe(true)
})

test('translate should only retranslate changed JavaScript groups', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse('Home', 'Inicio')
  mockProvider.setMockResponse('About', 'Acerca de')
  mockProvider.setMockResponse('Copyright 2024', 'Derechos reservados 2024')
  mockProvider.setMockResponse('About Us', 'Sobre Nosotros')

  const jsContent = `
const messages = {
  nav: {
    home: "Home",
    about: "About"
  },
  footer: {
    copyright: "Copyright 2024"
  }
}
`
  await writeFile(join(sourceDir, 'messages.js'), jsContent)

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  const updatedJsContent = `
const messages = {
  nav: {
    home: "Home",
    about: "About Us"
  },
  footer: {
    copyright: "Copyright 2024"
  }
}
`
  await writeFile(join(sourceDir, 'messages.js'), updatedJsContent)
  callCount = 0

  await orchestrate(config, '0.1.2')

  const outputContent = await readFile(join(targetDir, 'es', 'messages.js'), 'utf-8')
  expect(callCount).toBe(1)
  expect(outputContent).toContain('Sobre Nosotros')
  expect(outputContent).toContain('Derechos reservados 2024')
})

test('translate should skip unchanged markdown and preserve translated content', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse(
    '# Hello World\n\nWelcome to our app.',
    '# Hola Mundo\n\nBienvenido a nuestra app.',
  )

  await writeFile(join(sourceDir, 'test.md'), '# Hello World\n\nWelcome to our app.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')
  const firstOutput = await readFile(join(targetDir, 'es', 'test.md'), 'utf-8')
  expect(firstOutput).toContain('Hola Mundo')

  callCount = 0
  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(0)
  const secondOutput = await readFile(join(targetDir, 'es', 'test.md'), 'utf-8')
  expect(secondOutput).toBe(firstOutput)
})

test('translate should not create duplicate output files on repeated runs', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello', 'Hola')
  mockProvider.setMockResponse('Goodbye', 'Adiós')

  const jsonContent = { greeting: 'Hello', farewell: 'Goodbye' }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')
  await orchestrate(config, '0.1.2')
  await orchestrate(config, '0.1.2')

  const outputPath = join(targetDir, 'es', 'test.json')
  const output = JSON.parse(await readFile(outputPath, 'utf-8'))
  expect(output.greeting).toBe('Hola')
  expect(output.farewell).toBe('Adiós')
})

test('translate should respect retranslate=true for unchanged files', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse('Hello', 'Hola')

  await writeFile(join(sourceDir, 'test.json'), JSON.stringify({ greeting: 'Hello' }, null, 2))

  const baseConfig: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(baseConfig, '0.1.2')

  callCount = 0
  await orchestrate({ ...baseConfig, retranslate: true }, '0.1.2')

  expect(callCount).toBe(1)
})

test('excluded keys should use existing target values instead of source values', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello', 'Hola')
  mockProvider.setMockResponse('Welcome', 'Bienvenido')

  const jsonContent = {
    page: {
      title: 'Hello',
      description: 'Welcome',
      localizedSlug: 'hello-page',
    },
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const esTargetDir = join(targetDir, 'es')
  await mkdir(esTargetDir, { recursive: true })
  const existingTarget = {
    page: {
      title: 'Hola',
      description: 'Bienvenido',
      localizedSlug: 'pagina-hola',
    },
  }
  await writeFile(join(esTargetDir, 'test.json'), JSON.stringify(existingTarget, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    retranslate: true,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
      excludeKeys: ['localizedSlug'],
    },
  }

  await orchestrate(config, '0.1.2')

  const output = JSON.parse(await readFile(join(esTargetDir, 'test.json'), 'utf-8'))
  expect(output.page.localizedSlug).toBe('pagina-hola')
  expect(output.page.title).toBe('Hola')
})

test('excluded keys should fall back to source value when no target file exists', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello', 'Hola')

  const jsonContent = {
    page: {
      title: 'Hello',
      localizedSlug: 'hello-page',
    },
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
      excludeKeys: ['localizedSlug'],
    },
  }

  await orchestrate(config, '0.1.2')

  const output = JSON.parse(await readFile(join(targetDir, 'es', 'test.json'), 'utf-8'))
  expect(output.page.localizedSlug).toBe('hello-page')
  expect(output.page.title).toBe('Hola')
})

test('init mode should produce 0 LLM calls and build state', async () => {
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
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const esTargetDir = join(targetDir, 'es')
  await mkdir(esTargetDir, { recursive: true })
  const existingTarget = {
    nav: {
      home: 'Inicio',
      about: 'Acerca de',
    },
  }
  await writeFile(join(esTargetDir, 'test.json'), JSON.stringify(existingTarget, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    init: true,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(0)
})

test('after init, normal run should skip unchanged files', async () => {
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
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(jsonContent, null, 2))

  const esTargetDir = join(targetDir, 'es')
  await mkdir(esTargetDir, { recursive: true })
  const existingTarget = {
    nav: {
      home: 'Inicio',
      about: 'Acerca de',
    },
  }
  await writeFile(join(esTargetDir, 'test.json'), JSON.stringify(existingTarget, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate({ ...config, init: true }, '0.1.2')

  callCount = 0
  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(0)
})

test('after init, changing source should trigger retranslation of changed groups', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse('Home', 'Inicio')
  mockProvider.setMockResponse('About', 'Acerca de')
  mockProvider.setMockResponse('Welcome', 'Bienvenido')

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

  const esTargetDir = join(targetDir, 'es')
  await mkdir(esTargetDir, { recursive: true })
  const existingTarget = {
    nav: {
      home: 'Inicio',
      about: 'Acerca de',
    },
    footer: {
      copyright: 'Derechos reservados 2024',
    },
  }
  await writeFile(join(esTargetDir, 'test.json'), JSON.stringify(existingTarget, null, 2))

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await orchestrate({ ...config, init: true }, '0.1.2')

  const updatedJsonContent = {
    nav: {
      home: 'Home',
      about: 'About',
      welcome: 'Welcome',
    },
    footer: {
      copyright: 'Copyright 2024',
    },
  }
  await writeFile(join(sourceDir, 'test.json'), JSON.stringify(updatedJsonContent, null, 2))

  callCount = 0
  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(1)
  const output = JSON.parse(await readFile(join(esTargetDir, 'test.json'), 'utf-8'))
  expect(output.nav.welcome).toBe('Bienvenido')
  expect(output.footer.copyright).toBe('Derechos reservados 2024')
})

test('translation failures should not write partial output or skip the next retry', async () => {
  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Success', 'Éxito')
  mockProvider.setMockResponse('Retry me', 'Reintentar')
  const generate = mockProvider.generate.bind(mockProvider)
  let shouldFail = true

  mockProvider.generate = async (prompt, options) => {
    if (shouldFail && prompt.includes('Retry me')) {
      throw new Error('Temporary translation failure')
    }
    return generate(prompt, options)
  }

  await writeFile(
    join(sourceDir, 'test.json'),
    JSON.stringify({ first: { value: 'Success' }, second: { value: 'Retry me' } }),
  )

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    concurrency: 1,
    llm: mockProvider,
    files: {
      sourceDir,
      targetDir: join(targetDir, '[lang]'),
    },
  }

  await expect(orchestrate(config, '0.1.2')).rejects.toThrow()
  expect(existsSync(join(targetDir, 'es', 'test.json'))).toBe(false)

  shouldFail = false
  await orchestrate(config, '0.1.2')

  const output = JSON.parse(await readFile(join(targetDir, 'es', 'test.json'), 'utf-8'))
  expect(output.first.value).toBe('Éxito')
  expect(output.second.value).toBe('Reintentar')
})
