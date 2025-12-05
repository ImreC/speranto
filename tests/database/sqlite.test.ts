import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SQLiteAdapter } from '../../src/database/sqlite'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-translations.db'

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

test('getSourceRows returns all rows with specified columns', async () => {
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

test('ensureTranslationTable creates translation table', async () => {
  await adapter.ensureTranslationTable('articles', ['title', 'body'], 'id', '_translations')

  const db = new Database(TEST_DB)
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='articles_translations'",
    )
    .all()
  db.close()

  expect(tables).toHaveLength(1)
})

test('upsertTranslation inserts new translation', async () => {
  await adapter.ensureTranslationTable('articles', ['title', 'body'], 'id', '_translations')

  await adapter.upsertTranslation(
    'articles',
    {
      sourceId: 1,
      lang: 'es',
      columns: { title: 'Hola Mundo', body: 'Este es el cuerpo.' },
    },
    '_translations',
  )

  const existing = await adapter.getExistingTranslation('articles', 1, 'es', '_translations')
  expect(existing).not.toBeNull()
  expect(existing?.columns.title).toBe('Hola Mundo')
  expect(existing?.columns.body).toBe('Este es el cuerpo.')
})

test('upsertTranslation updates existing translation', async () => {
  await adapter.ensureTranslationTable('articles', ['title', 'body'], 'id', '_translations')

  await adapter.upsertTranslation(
    'articles',
    {
      sourceId: 1,
      lang: 'es',
      columns: { title: 'Hola Mundo', body: 'Este es el cuerpo.' },
    },
    '_translations',
  )

  await adapter.upsertTranslation(
    'articles',
    {
      sourceId: 1,
      lang: 'es',
      columns: { title: 'Hola Mundo Actualizado', body: 'Cuerpo actualizado.' },
    },
    '_translations',
  )

  const existing = await adapter.getExistingTranslation('articles', 1, 'es', '_translations')
  expect(existing?.columns.title).toBe('Hola Mundo Actualizado')
  expect(existing?.columns.body).toBe('Cuerpo actualizado.')
})

test('getExistingTranslation returns null for non-existent translation', async () => {
  await adapter.ensureTranslationTable('articles', ['title', 'body'], 'id', '_translations')

  const existing = await adapter.getExistingTranslation('articles', 999, 'fr', '_translations')
  expect(existing).toBeNull()
})

test('getTranslationTableName returns correct name', () => {
  const name = adapter.getTranslationTableName('articles', '_translations')
  expect(name).toBe('articles_translations')
})
