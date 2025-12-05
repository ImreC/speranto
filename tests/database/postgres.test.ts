import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { SQL } from 'bun'
import { PostgresAdapter } from '../../src/database/postgres'

const CONNECTION_STRING = 'postgres://test:test@localhost:5432/speranto_test'

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

test('pg - ensureTranslationTable creates translation table', async () => {
  await adapter.ensureTranslationTable('articles', ['title', 'body'], 'id', '_translations')

  const tables = await sql.unsafe(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'articles_translations'
  `)

  expect(tables).toHaveLength(1)
})

test('pg - upsertTranslation inserts new translation', async () => {
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

test('pg - upsertTranslation updates existing translation', async () => {
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

test('pg - getExistingTranslation returns null for non-existent translation', async () => {
  await adapter.ensureTranslationTable('articles', ['title', 'body'], 'id', '_translations')

  const existing = await adapter.getExistingTranslation('articles', 999, 'fr', '_translations')
  expect(existing).toBeNull()
})

test('pg - getTranslationTableName returns correct name', () => {
  const name = adapter.getTranslationTableName('articles', '_translations')
  expect(name).toBe('articles_translations')
})
