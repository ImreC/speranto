import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { SQL } from 'bun'
import { PostgresAdapter } from '../../src/database/postgres'
import type { TableConfig } from '../../src/types'

const CONNECTION_STRING = 'postgres://test:test@localhost:5432/speranto_test'

const articlesTable: TableConfig = {
  name: 'articles',
  columns: ['title', 'body'],
}

let adapter: PostgresAdapter
let sql: SQL

beforeAll(async () => {
  sql = new SQL(CONNECTION_STRING)

  await sql.unsafe(`DROP TABLE IF EXISTS articles_translations`)
  await sql.unsafe(`DROP TABLE IF EXISTS articles`)

  await sql.unsafe(`
    CREATE TABLE articles (
      id SERIAL PRIMARY KEY,
      title TEXT,
      body TEXT,
      slug TEXT
    )
  `)
})

beforeEach(async () => {
  await sql.unsafe(`TRUNCATE TABLE articles RESTART IDENTITY CASCADE`)
  await sql.unsafe(`DROP TABLE IF EXISTS articles_translations`)

  await sql.unsafe(
    `INSERT INTO articles (title, body, slug) VALUES ('Hello World', 'This is the body.', 'hello-world')`,
  )
  await sql.unsafe(
    `INSERT INTO articles (title, body, slug) VALUES ('Second Post', 'Another body here.', 'second-post')`,
  )

  adapter = new PostgresAdapter(CONNECTION_STRING)
  await adapter.connect()
})

afterAll(async () => {
  await adapter?.close()
  await sql.unsafe(`DROP TABLE IF EXISTS articles_translations`)
  await sql.unsafe(`DROP TABLE IF EXISTS articles`)
  await sql.close()
})

test('pg - getSourceRows returns all rows with specified columns', async () => {
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

test('pg - getSourceRows includes langColumn when configured', async () => {
  await sql.unsafe(`ALTER TABLE articles ADD COLUMN lang TEXT DEFAULT 'en'`)
  await sql.unsafe(`UPDATE articles SET lang = 'nl' WHERE id = 2`)

  const rows = await adapter.getSourceRows({
    name: 'articles',
    columns: ['title', 'body'],
    langColumn: 'lang',
  })

  expect(rows[0]?.sourceLang).toBe('en')
  expect(rows[1]?.sourceLang).toBe('nl')
})

test('pg - ensureTranslationTable creates translation table', async () => {
  await adapter.ensureTranslationTable(articlesTable, '_translations')

  const tables = await sql.unsafe(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'articles_translations'
  `)

  expect(tables).toHaveLength(1)
})

test('pg - upsertTranslation inserts new translation', async () => {
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

test('pg - upsertTranslation updates existing translation', async () => {
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

test('pg - getTranslations returns empty list for non-existent translations', async () => {
  await adapter.ensureTranslationTable(articlesTable, '_translations')

  const translations = await adapter.getTranslations(articlesTable, '_translations')
  expect(translations).toHaveLength(0)
})
