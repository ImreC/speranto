import pg from 'pg'
import { DatabaseAdapter, type SourceRow, type TranslationRow } from './adapter'
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
    const columnDefs = table.columns.map((col) => `"${col}" TEXT`).join(', ')

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${translationTable} (
        id SERIAL PRIMARY KEY,
        source_id TEXT NOT NULL,
        lang TEXT NOT NULL,
        ${columnDefs},
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_id, lang)
      )
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
    const selectColumns = [idColumn, ...table.columns].map((c) => `"${c}"`).join(', ')
    const qualifiedTable = this.getQualifiedTableName(table)

    const result = await this.client.query(
      `SELECT ${selectColumns} FROM ${qualifiedTable}`,
    )
    const rows = result.rows as Record<string, unknown>[]

    return rows.map((row) => ({
      id: row[idColumn] as string | number,
      columns: table.columns.reduce((acc, col) => {
        const value = row[col]
        acc[col] = value != null ? String(value) : ''
        return acc
      }, {} as Record<string, string>),
    }))
  }

  async getTranslatedIds(
    table: TableConfig,
    lang: string,
    suffix: string,
  ): Promise<Set<string>> {
    if (!this.client) throw new Error('Database not connected')

    const translationTable = this.getQualifiedTableName(table, suffix)

    try {
      const result = await this.client.query(
        `SELECT source_id FROM ${translationTable} WHERE lang = $1`,
        [lang],
      )
      const rows = result.rows as { source_id: string }[]
      return new Set(rows.map((r) => r.source_id))
    } catch {
      return new Set()
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
    const quotedColumns = columnNames.map((c) => `"${c}"`).join(', ')
    const placeholders = columnNames.map((_, i) => `$${i + 3}`).join(', ')
    const updateSet = columnNames.map((col) => `"${col}" = EXCLUDED."${col}"`).join(', ')

    const values = [
      String(translation.sourceId),
      translation.lang,
      ...columnNames.map((col) => translation.columns[col]),
    ]

    await this.client.query(
      `
      INSERT INTO ${translationTable} (source_id, lang, ${quotedColumns}, updated_at)
      VALUES ($1, $2, ${placeholders}, NOW())
      ON CONFLICT(source_id, lang) DO UPDATE SET
        ${updateSet},
        updated_at = NOW()
    `,
      values,
    )
  }
}
