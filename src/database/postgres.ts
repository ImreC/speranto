import pg from 'pg'
import {
  DatabaseAdapter,
  type SourceRow,
  type StoredTranslationRow,
  type TranslationRow,
} from './adapter'
import type { TableConfig } from '../types'

const DEFAULT_SCHEMA = 'public'

export class PostgresAdapter extends DatabaseAdapter {
  private client: pg.Client | null = null
  private connectionString: string

  constructor(connectionString: string) {
    super()
    this.connectionString = connectionString
  }

  async connect(): Promise<void> {
    this.client = new pg.Client({ connectionString: this.connectionString })
    try {
      await this.client.connect()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to connect to PostgreSQL: ${message}\n` +
          'Check that your connection string is valid: postgresql://user:password@host:5432/dbname',
      )
    }
  }

  async close(): Promise<void> {
    await this.client?.end()
    this.client = null
  }

  private getQualifiedTableName(table: TableConfig, suffix = ''): string {
    const schema = table.schema || DEFAULT_SCHEMA
    return `"${schema}"."${table.name}${suffix}"`
  }

  private getIndexName(table: TableConfig, suffix: string): string {
    const schema = table.schema || DEFAULT_SCHEMA
    return `idx_${schema}_${table.name}${suffix}_source_lang`
  }

  async ensureTranslationTable(table: TableConfig, suffix: string): Promise<void> {
    if (!this.client) throw new Error('Database not connected')

    const translationTable = this.getQualifiedTableName(table, suffix)
    const columnDefs = [
      'id SERIAL PRIMARY KEY',
      'source_id TEXT NOT NULL',
      'lang TEXT NOT NULL',
      "source_lang TEXT NOT NULL DEFAULT ''",
      "row_source_hash TEXT NOT NULL DEFAULT ''",
      "field_source_hashes TEXT NOT NULL DEFAULT '{}'",
      ...table.columns.map((col) => `"${col}" TEXT`),
      'created_at TIMESTAMPTZ DEFAULT NOW()',
      'updated_at TIMESTAMPTZ DEFAULT NOW()',
      'UNIQUE(source_id, lang)',
    ].join(',\n        ')

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${translationTable} (
        ${columnDefs}
      )
    `)

    await this.client.query(`
      ALTER TABLE ${translationTable}
      ADD COLUMN IF NOT EXISTS source_lang TEXT NOT NULL DEFAULT ''
    `)
    await this.client.query(`
      ALTER TABLE ${translationTable}
      ADD COLUMN IF NOT EXISTS row_source_hash TEXT NOT NULL DEFAULT ''
    `)
    await this.client.query(`
      ALTER TABLE ${translationTable}
      ADD COLUMN IF NOT EXISTS field_source_hashes TEXT NOT NULL DEFAULT '{}'
    `)

    const indexName = this.getIndexName(table, suffix)
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS "${indexName}"
      ON ${translationTable}(source_id, lang)
    `)
  }

  async getSourceRows(table: TableConfig): Promise<SourceRow[]> {
    if (!this.client) throw new Error('Database not connected')

    const idColumn = table.idColumn || 'id'
    const selectColumns = [
      idColumn,
      ...table.columns,
      ...(table.langColumn ? [table.langColumn] : []),
    ]
      .map((c) => `"${c}"`)
      .join(', ')
    const qualifiedTable = this.getQualifiedTableName(table)

    const result = await this.client.query(`SELECT ${selectColumns} FROM ${qualifiedTable}`)
    const rows = result.rows as Record<string, unknown>[]

    return rows.map((row) => ({
      id: row[idColumn] as string | number,
      columns: table.columns.reduce((acc, col) => {
        const value = row[col]
        acc[col] = value != null ? String(value) : ''
        return acc
      }, {} as Record<string, string>),
      sourceLang:
        table.langColumn && row[table.langColumn] != null
          ? String(row[table.langColumn])
          : undefined,
    }))
  }

  async getTranslations(table: TableConfig, suffix: string): Promise<StoredTranslationRow[]> {
    if (!this.client) throw new Error('Database not connected')

    const translationTable = this.getQualifiedTableName(table, suffix)
    const quotedColumns = table.columns.map((c) => `"${c}"`).join(', ')
    const selectColumns = quotedColumns ? `, ${quotedColumns}` : ''

    try {
      const result = await this.client.query(
        `SELECT source_id, lang, source_lang, row_source_hash, field_source_hashes${selectColumns}
         FROM ${translationTable}`,
      )
      const rows = result.rows as Record<string, unknown>[]

      return rows.map((row) => ({
        sourceId: row.source_id as string,
        lang: String(row.lang ?? ''),
        sourceLang: String(row.source_lang ?? ''),
        rowSourceHash: String(row.row_source_hash ?? ''),
        fieldSourceHashes: parseFieldHashes(row.field_source_hashes),
        columns: table.columns.reduce((acc, col) => {
          const value = row[col]
          acc[col] = value != null ? String(value) : ''
          return acc
        }, {} as Record<string, string>),
      }))
    } catch {
      return []
    }
  }

  async upsertTranslation(
    table: TableConfig,
    translation: TranslationRow,
    suffix: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Database not connected')

    const translationTable = this.getQualifiedTableName(table, suffix)
    const columnNames = Object.keys(translation.columns)
    const insertColumns = [
      'source_id',
      'lang',
      'source_lang',
      'row_source_hash',
      'field_source_hashes',
      ...columnNames,
    ]
    const quotedColumns = insertColumns.map((c) => `"${c}"`).join(', ')
    const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ')
    const updateSet = [
      '"source_lang" = EXCLUDED."source_lang"',
      '"row_source_hash" = EXCLUDED."row_source_hash"',
      '"field_source_hashes" = EXCLUDED."field_source_hashes"',
      ...columnNames.map((col) => `"${col}" = EXCLUDED."${col}"`),
    ].join(', ')

    const values = [
      String(translation.sourceId),
      translation.lang,
      translation.sourceLang,
      translation.rowSourceHash,
      JSON.stringify(translation.fieldSourceHashes),
      ...columnNames.map((col) => translation.columns[col]),
    ]

    await this.client.query(
      `
      INSERT INTO ${translationTable} (${quotedColumns}, updated_at)
      VALUES (${placeholders}, NOW())
      ON CONFLICT(source_id, lang) DO UPDATE SET
        ${updateSet},
        updated_at = NOW()
    `,
      values,
    )
  }
  override async upsertTranslations(
    table: TableConfig,
    translations: TranslationRow[],
    suffix: string,
  ): Promise<void> {
    if (!this.client || translations.length === 0) return

    await this.client.query('BEGIN')
    try {
      for (const translation of translations) {
        await this.upsertTranslation(table, translation, suffix)
      }
      await this.client.query('COMMIT')
    } catch (err) {
      await this.client.query('ROLLBACK')
      throw err
    }
  }
}

function parseFieldHashes(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || !value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
