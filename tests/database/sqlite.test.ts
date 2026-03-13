import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SQLiteAdapter } from '../../src/database/sqlite'
import { unlinkSync, existsSync } from 'fs'
import type { TableConfig } from '../../src/types'

const TEST_DB = './test-translations.db'

const articlesTable: TableConfig = {
  name: 'articles',
  columns: ['title', 'body'],
}

let adapter: SQLiteAdapter

beforeEach(async () => {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB)
  }

  const db = new Database(TEST_DB)
  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT,
      slug TEXT
    )
  `)
  db.run(
    `INSERT INTO articles (title, body, slug) VALUES ('Hello World', 'This is the body.', 'hello-world')`,
  )
  db.run(
    `INSERT INTO articles (title, body, slug) VALUES ('Second Post', 'Another body here.', 'second-post')`,
  )
  db.close()

  adapter = new SQLiteAdapter(TEST_DB)
  await adapter.connect()
})

afterEach(async () => {
  await adapter.close()
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB)
  }
})

test('sqlite - getSourceRows returns all rows with specified columns', async () => {
  const rows = await adapter.getSourceRows({
    name: 'articles',
    columns: ['title', 'body'],
  })

  expect(rows).toHaveLength(2)
  expect(rows[0]?.id).toBe(1)
  expect(rows[0]?.columns.title).toBe('Hello World')
  expect(rows[0]?.columns.body).toBe('This is the body.')
  expect(rows[1]?.id).toBe(2)
  expect(rows[1]?.columns.title).toBe('Second Post')
})

test('sqlite - getSourceRows includes langColumn when configured', async () => {
  await adapter.close()

  const db = new Database(TEST_DB)
  db.run(`ALTER TABLE articles ADD COLUMN lang TEXT DEFAULT 'en'`)
  db.run(`UPDATE articles SET lang = 'nl' WHERE id = 2`)
  db.close()

  adapter = new SQLiteAdapter(TEST_DB)
  await adapter.connect()

  const rows = await adapter.getSourceRows({
    name: 'articles',
    columns: ['title', 'body'],
    langColumn: 'lang',
  })

  expect(rows[0]?.sourceLang).toBe('en')
  expect(rows[1]?.sourceLang).toBe('nl')
})

test('sqlite - ensureTranslationTable creates translation table', async () => {
  await adapter.ensureTranslationTable(articlesTable, '_translations')

  const db = new Database(TEST_DB)
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='articles_translations'",
    )
    .all()
  db.close()

  expect(tables).toHaveLength(1)
})

test('sqlite - upsertTranslation inserts new translation', async () => {
  await adapter.ensureTranslationTable(articlesTable, '_translations')

  await adapter.upsertTranslation(
    articlesTable,
    {
      sourceId: 1,
      lang: 'es',
      sourceLang: 'en',
      rowSourceHash: 'row-hash-1',
      fieldSourceHashes: {
        title: 'title-hash-1',
        body: 'body-hash-1',
      },
      columns: { title: 'Hola Mundo', body: 'Este es el cuerpo.' },
    },
    '_translations',
  )

  const translations = await adapter.getTranslations(articlesTable, '_translations')
  expect(translations).toHaveLength(1)
  expect(translations[0]?.sourceId).toBe('1')
  expect(translations[0]?.lang).toBe('es')
  expect(translations[0]?.sourceLang).toBe('en')
  expect(translations[0]?.rowSourceHash).toBe('row-hash-1')
  expect(translations[0]?.fieldSourceHashes.title).toBe('title-hash-1')
})

test('sqlite - upsertTranslation updates existing translation', async () => {
  await adapter.ensureTranslationTable(articlesTable, '_translations')

  await adapter.upsertTranslation(
    articlesTable,
    {
      sourceId: 1,
      lang: 'es',
      sourceLang: 'en',
      rowSourceHash: 'row-hash-1',
      fieldSourceHashes: {
        title: 'title-hash-1',
        body: 'body-hash-1',
      },
      columns: { title: 'Hola Mundo', body: 'Este es el cuerpo.' },
    },
    '_translations',
  )

  await adapter.upsertTranslation(
    articlesTable,
    {
      sourceId: 1,
      lang: 'es',
      sourceLang: 'en',
      rowSourceHash: 'row-hash-2',
      fieldSourceHashes: {
        title: 'title-hash-2',
        body: 'body-hash-2',
      },
      columns: { title: 'Hola Mundo Actualizado', body: 'Cuerpo actualizado.' },
    },
    '_translations',
  )

  const translations = await adapter.getTranslations(articlesTable, '_translations')
  expect(translations).toHaveLength(1)
  expect(translations[0]?.rowSourceHash).toBe('row-hash-2')
  expect(translations[0]?.columns.title).toBe('Hola Mundo Actualizado')
})

test('sqlite - getTranslations returns empty list for non-existent translations', async () => {
  await adapter.ensureTranslationTable(articlesTable, '_translations')

  const translations = await adapter.getTranslations(articlesTable, '_translations')
  expect(translations).toHaveLength(0)
})
