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

  private getTranslationTableName(table: TableConfig, suffix: string): string {
    return `${table.name}${suffix}`
  }

  async ensureTranslationTable(table: TableConfig, suffix: string): Promise<void> {
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(table, suffix)
    const columnDefs = table.columns.map((col) => `${col} TEXT`).join(', ')

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
          const value = row[col]
          acc[col] = value != null ? String(value) : ''
          return acc
        },
        {} as Record<string, string>,
      ),
    }))
  }

  async getTranslatedIds(
    table: TableConfig,
    lang: string,
    suffix: string,
  ): Promise<Set<string>> {
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(table, suffix)

    try {
      const stmt = this.db.prepare(`SELECT source_id FROM ${translationTable} WHERE lang = ?`)
      stmt.bind([lang])
      const ids = new Set<string>()
      while (stmt.step()) {
        const row = stmt.getAsObject() as { source_id: string }
        ids.add(row.source_id)
      }
      stmt.free()
      return ids
    } catch {
      return new Set()
    }
  }

  async upsertTranslation(
    table: TableConfig,
    translation: TranslationRow,
    suffix: string,
  ): Promise<void> {
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(table, suffix)
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
      ...columnNames.map((col) => translation.columns[col] ?? ''),
    ]

    this.db.run(sql, values)
    this.save()
  }
}
