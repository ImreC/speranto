import { SQL } from 'bun'
import { DatabaseAdapter, type SourceRow, type TranslationRow } from './adapter'
import type { TableConfig } from '../types'

export class PostgresAdapter extends DatabaseAdapter {
  private sql: SQL | null = null
  private connectionString: string

  constructor(connectionString: string) {
    super()
    this.connectionString = connectionString
  }

  async connect(): Promise<void> {
    this.sql = new SQL(this.connectionString)
  }

  async close(): Promise<void> {
    await this.sql?.close()
    this.sql = null
  }

  getTranslationTableName(sourceTable: string, suffix: string): string {
    return `${sourceTable}${suffix}`
  }

  async ensureTranslationTable(
    sourceTable: string,
    columns: string[],
    _idColumn: string,
    suffix: string,
  ): Promise<void> {
    if (!this.sql) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(sourceTable, suffix)

    const columnDefs = columns.map((col) => `"${col}" TEXT`).join(', ')

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${translationTable}" (
        id SERIAL PRIMARY KEY,
        source_id TEXT NOT NULL,
        lang TEXT NOT NULL,
        ${columnDefs},
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_id, lang)
      )
    `)

    await this.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${translationTable}_source_lang"
      ON "${translationTable}"(source_id, lang)
    `)
  }

  async getSourceRows(table: TableConfig): Promise<SourceRow[]> {
    if (!this.sql) throw new Error('Database not connected')

    const idColumn = table.idColumn || 'id'
    const selectColumns = [idColumn, ...table.columns].map((c) => `"${c}"`).join(', ')

    const rows = (await this.sql.unsafe(
      `SELECT ${selectColumns} FROM "${table.name}"`,
    )) as Record<string, unknown>[]

    return rows.map((row) => ({
      id: row[idColumn] as string | number,
      columns: table.columns.reduce((acc, col) => {
        acc[col] = row[col] as string
        return acc
      }, {} as Record<string, string>),
    }))
  }

  async getExistingTranslation(
    sourceTable: string,
    sourceId: string | number,
    lang: string,
    suffix: string,
  ): Promise<TranslationRow | null> {
    if (!this.sql) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(sourceTable, suffix)

    try {
      const rows = (await this.sql.unsafe(
        `SELECT * FROM "${translationTable}" WHERE source_id = $1 AND lang = $2`,
        [String(sourceId), lang],
      )) as Record<string, unknown>[]

      const row = rows[0]
      if (!row) return null

      const columns: Record<string, string> = {}
      for (const [key, value] of Object.entries(row)) {
        if (!['id', 'source_id', 'lang', 'created_at', 'updated_at'].includes(key)) {
          columns[key] = value as string
        }
      }

      return {
        sourceId: row.source_id as string | number,
        lang: row.lang as string,
        columns,
      }
    } catch {
      return null
    }
  }

  async upsertTranslation(
    sourceTable: string,
    translation: TranslationRow,
    suffix: string,
  ): Promise<void> {
    if (!this.sql) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(sourceTable, suffix)
    const columnNames = Object.keys(translation.columns)
    const quotedColumns = columnNames.map((c) => `"${c}"`).join(', ')
    const placeholders = columnNames.map((_, i) => `$${i + 3}`).join(', ')
    const updateSet = columnNames.map((col) => `"${col}" = EXCLUDED."${col}"`).join(', ')

    const values = [
      String(translation.sourceId),
      translation.lang,
      ...columnNames.map((col) => translation.columns[col]),
    ]

    await this.sql.unsafe(
      `
      INSERT INTO "${translationTable}" (source_id, lang, ${quotedColumns}, updated_at)
      VALUES ($1, $2, ${placeholders}, NOW())
      ON CONFLICT(source_id, lang) DO UPDATE SET
        ${updateSet},
        updated_at = NOW()
    `,
      values,
    )
  }
}
