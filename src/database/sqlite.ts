import initSqlJs, { type Database } from 'sql.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DatabaseAdapter, type SourceRow, type TranslationRow } from './adapter'
import type { TableConfig } from '../types'

export class SQLiteAdapter extends DatabaseAdapter {
  private db: Database | null = null
  private connectionString: string

  constructor(connectionString: string) {
    super()
    this.connectionString = connectionString
  }

  async connect(): Promise<void> {
    const SQL = await initSqlJs()
    if (existsSync(this.connectionString)) {
      const buffer = readFileSync(this.connectionString)
      this.db = new SQL.Database(buffer)
    } else {
      this.db = new SQL.Database()
    }
  }

  private save(): void {
    if (this.db) {
      const data = this.db.export()
      writeFileSync(this.connectionString, Buffer.from(data))
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.save()
      this.db.close()
      this.db = null
    }
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
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(sourceTable, suffix)

    const columnDefs = columns.map((col) => `${col} TEXT`).join(', ')

    const sql = `
      CREATE TABLE IF NOT EXISTS ${translationTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        lang TEXT NOT NULL,
        ${columnDefs},
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_id, lang)
      )
    `

    this.db.run(sql)

    const indexSql = `
      CREATE INDEX IF NOT EXISTS idx_${translationTable}_source_lang
      ON ${translationTable}(source_id, lang)
    `
    this.db.run(indexSql)
    this.save()
  }

  async getSourceRows(table: TableConfig): Promise<SourceRow[]> {
    if (!this.db) throw new Error('Database not connected')

    const idColumn = table.idColumn || 'id'
    const selectColumns = [idColumn, ...table.columns].join(', ')

    const sql = `SELECT ${selectColumns} FROM ${table.name}`
    const stmt = this.db.prepare(sql)
    const rows: Record<string, unknown>[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>)
    }
    stmt.free()

    return rows.map((row) => ({
      id: row[idColumn] as string | number,
      columns: table.columns.reduce(
        (acc, col) => {
          acc[col] = row[col] as string
          return acc
        },
        {} as Record<string, string>,
      ),
    }))
  }

  async getExistingTranslation(
    sourceTable: string,
    sourceId: string | number,
    lang: string,
    suffix: string,
  ): Promise<TranslationRow | null> {
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(sourceTable, suffix)

    const sql = `SELECT * FROM ${translationTable} WHERE source_id = ? AND lang = ?`

    try {
      const stmt = this.db.prepare(sql)
      stmt.bind([String(sourceId), lang])
      if (!stmt.step()) {
        stmt.free()
        return null
      }
      const row = stmt.getAsObject() as Record<string, unknown>
      stmt.free()

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
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(sourceTable, suffix)
    const columnNames = Object.keys(translation.columns)
    const columnPlaceholders = columnNames.map(() => '?').join(', ')
    const updateSet = columnNames.map((col) => `${col} = excluded.${col}`).join(', ')

    const sql = `
      INSERT INTO ${translationTable} (source_id, lang, ${columnNames.join(', ')}, updated_at)
      VALUES (?, ?, ${columnPlaceholders}, CURRENT_TIMESTAMP)
      ON CONFLICT(source_id, lang) DO UPDATE SET
        ${updateSet},
        updated_at = CURRENT_TIMESTAMP
    `

    const values = [
      String(translation.sourceId),
      translation.lang,
      ...columnNames.map((col) => translation.columns[col]),
    ]

    this.db.run(sql, values)
    this.save()
  }
}
