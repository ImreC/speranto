import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'path'
import { orchestrate } from '../../src/orchestrate'
import type { Config } from '../../src/types'
import { MockLLMProvider } from '../mocks/LLMProvider'

const testDir = join(process.cwd(), 'test-db-fixtures')
const dbPath = join(testDir, 'content.db')

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

test('sqlite db - orchestrate writes base and translated rows to translation table', async () => {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    )
  `)
  db.run(`INSERT INTO articles (title, body) VALUES ('Hello World', 'This is the body.')`)
  db.run(`INSERT INTO articles (title, body) VALUES ('Second Post', 'Another body here.')`)
  db.close()

  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')
  mockProvider.setMockResponse('This is the body.', 'Este es el cuerpo.')
  mockProvider.setMockResponse('Second Post', 'Segundo Post')
  mockProvider.setMockResponse('Another body here.', 'Otro cuerpo aqui.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    database: {
      type: 'sqlite',
      connection: dbPath,
      tables: [
        {
          name: 'articles',
          columns: ['title', 'body'],
        },
      ],
    },
  }

  await orchestrate(config, '0.1.2')

  const readDb = new Database(dbPath, { readonly: true })
  const rows = readDb
    .query(
      'SELECT source_id, lang, source_lang, title, body, row_source_hash FROM articles_translations ORDER BY source_id, lang',
    )
    .all() as Array<{
      source_id: string
      lang: string
      source_lang: string
      title: string
      body: string
      row_source_hash: string
    }>
  readDb.close()

  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({
    source_id: '1',
    lang: 'en',
    source_lang: 'en',
    title: 'Hello World',
  })
  expect(rows[1]).toMatchObject({
    source_id: '1',
    lang: 'es',
    source_lang: 'en',
    title: 'Hola Mundo',
  })
  expect(rows[0]?.row_source_hash).toBeTruthy()
  expect(rows[1]?.row_source_hash).toBeTruthy()
})

test('sqlite db - orchestrate uses langColumn per row and excludes same-language target', async () => {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      lang TEXT,
      title TEXT,
      body TEXT
    )
  `)
  db.run(`INSERT INTO articles (lang, title, body) VALUES ('en', 'Hello World', 'This is the body.')`)
  db.run(`INSERT INTO articles (lang, title, body) VALUES ('nl', 'Hallo Wereld', 'Dit is de inhoud.')`)
  db.close()

  class LanguageAwareMockProvider extends MockLLMProvider {
    override async generate(prompt: string, options?: any) {
      if (prompt.includes('Hallo Wereld') && prompt.includes('to en')) {
        return {
          content: JSON.stringify(
            {
              title: 'Hello World',
              body: 'This is the body.',
            },
            null,
            2,
          ),
          model: 'test-model',
        }
      }

      if (prompt.includes('Hallo Wereld') && prompt.includes('to es')) {
        return {
          content: JSON.stringify(
            {
              title: 'Hola Mundo',
              body: 'Este es el cuerpo.',
            },
            null,
            2,
          ),
          model: 'test-model',
        }
      }

      return super.generate(prompt, options)
    }
  }

  const mockProvider = new LanguageAwareMockProvider('test-model')
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')
  mockProvider.setMockResponse('This is the body.', 'Este es el cuerpo.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['en', 'es', 'nl'],
    provider: 'mistral',
    llm: mockProvider,
    database: {
      type: 'sqlite',
      connection: dbPath,
      tables: [
        {
          name: 'articles',
          columns: ['title', 'body'],
          langColumn: 'lang',
        },
      ],
    },
  }

  await orchestrate(config, '0.1.2')

  const readDb = new Database(dbPath, { readonly: true })
  const rows = readDb
    .query(
      'SELECT source_id, lang, source_lang, title FROM articles_translations ORDER BY source_id, lang',
    )
    .all() as Array<{
      source_id: string
      lang: string
      source_lang: string
      title: string
    }>
  readDb.close()

  const row1 = rows.filter((row) => row.source_id === '1')
  const row2 = rows.filter((row) => row.source_id === '2')

  expect(row1.map((row) => row.lang)).toEqual(['en', 'es', 'nl'])
  expect(row2.map((row) => row.lang)).toEqual(['en', 'es', 'nl'])
  expect(row2.find((row) => row.lang === 'nl')?.source_lang).toBe('nl')
  expect(row2.find((row) => row.lang === 'nl')?.title).toBe('Hallo Wereld')
})

test('sqlite db - orchestrate only retranslates changed fields', async () => {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    )
  `)
  db.run(`INSERT INTO articles (title, body) VALUES ('Hello World', 'This is the body.')`)
  db.close()

  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')
  mockProvider.setMockResponse('This is the body.', 'Este es el cuerpo.')
  mockProvider.setMockResponse('Hello Again', 'Hola de Nuevo')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    database: {
      type: 'sqlite',
      connection: dbPath,
      tables: [
        {
          name: 'articles',
          columns: ['title', 'body'],
        },
      ],
    },
  }

  await orchestrate(config, '0.1.2')

  const updateDb = new Database(dbPath)
  updateDb.run(`UPDATE articles SET title = 'Hello Again' WHERE id = 1`)
  updateDb.close()

  callCount = 0
  await orchestrate(config, '0.1.2')

  const readDb = new Database(dbPath, { readonly: true })
  const row = readDb
    .query(`SELECT title, body FROM articles_translations WHERE source_id = '1' AND lang = 'es'`)
    .get() as { title: string; body: string }
  readDb.close()

  expect(callCount).toBe(1)
  expect(row.title).toBe('Hola de Nuevo')
  expect(row.body).toBe('Este es el cuerpo.')
})

test('sqlite db - orchestrate skips unchanged rows entirely', async () => {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    )
  `)
  db.run(`INSERT INTO articles (title, body) VALUES ('Hello World', 'This is the body.')`)
  db.run(`INSERT INTO articles (title, body) VALUES ('Second Post', 'Another body here.')`)
  db.close()

  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')
  mockProvider.setMockResponse('This is the body.', 'Este es el cuerpo.')
  mockProvider.setMockResponse('Second Post', 'Segundo Post')
  mockProvider.setMockResponse('Another body here.', 'Otro cuerpo aqui.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    database: {
      type: 'sqlite',
      connection: dbPath,
      tables: [
        {
          name: 'articles',
          columns: ['title', 'body'],
        },
      ],
    },
  }

  await orchestrate(config, '0.1.2')
  expect(callCount).toBeGreaterThan(0)

  callCount = 0
  await orchestrate(config, '0.1.2')

  expect(callCount).toBe(0)

  const readDb = new Database(dbPath, { readonly: true })
  const rows = readDb
    .query(
      'SELECT source_id, lang, title, body FROM articles_translations WHERE lang = \'es\' ORDER BY source_id',
    )
    .all() as Array<{
      source_id: string
      lang: string
      title: string
      body: string
    }>
  readDb.close()

  expect(rows).toHaveLength(2)
  expect(rows[0]?.title).toBe('Hola Mundo')
  expect(rows[1]?.title).toBe('Segundo Post')
})

test('sqlite db - orchestrate does not create duplicate translation rows', async () => {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    )
  `)
  db.run(`INSERT INTO articles (title, body) VALUES ('Hello World', 'This is the body.')`)
  db.close()

  const mockProvider = new MockLLMProvider('test-model')
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')
  mockProvider.setMockResponse('This is the body.', 'Este es el cuerpo.')

  const config: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    database: {
      type: 'sqlite',
      connection: dbPath,
      tables: [
        {
          name: 'articles',
          columns: ['title', 'body'],
        },
      ],
    },
  }

  await orchestrate(config, '0.1.2')
  await orchestrate({ ...config, retranslate: true }, '0.1.2')
  await orchestrate({ ...config, retranslate: true }, '0.1.2')

  const readDb = new Database(dbPath, { readonly: true })
  const rows = readDb
    .query('SELECT source_id, lang FROM articles_translations ORDER BY source_id, lang')
    .all() as Array<{ source_id: string; lang: string }>
  readDb.close()

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ source_id: '1', lang: 'en' })
  expect(rows[1]).toMatchObject({ source_id: '1', lang: 'es' })
})

test('sqlite db - orchestrate respects retranslate=true even when hashes match', async () => {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    )
  `)
  db.run(`INSERT INTO articles (title, body) VALUES ('Hello World', 'This is the body.')`)
  db.close()

  const mockProvider = new MockLLMProvider('test-model')
  let callCount = 0
  const originalGenerate = mockProvider.generate.bind(mockProvider)
  mockProvider.generate = async (...args) => {
    callCount++
    return originalGenerate(...args)
  }
  mockProvider.setMockResponse('Hello World', 'Hola Mundo')
  mockProvider.setMockResponse('This is the body.', 'Este es el cuerpo.')

  const baseConfig: Config = {
    model: 'test-model',
    sourceLang: 'en',
    targetLangs: ['es'],
    provider: 'mistral',
    llm: mockProvider,
    database: {
      type: 'sqlite',
      connection: dbPath,
      tables: [
        {
          name: 'articles',
          columns: ['title', 'body'],
        },
      ],
    },
  }

  await orchestrate(baseConfig, '0.1.2')

  callCount = 0
  await orchestrate({ ...baseConfig, retranslate: true }, '0.1.2')

  expect(callCount).toBe(1)
})
