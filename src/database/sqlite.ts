import initSqlJs, { type Database } from 'sql.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  DatabaseAdapter,
  type SourceRow,
  type StoredTranslationRow,
  type TranslationRow,
} from './adapter'
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
    const columnDefs = [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      'source_id TEXT NOT NULL',
      'lang TEXT NOT NULL',
      "source_lang TEXT NOT NULL DEFAULT ''",
      "row_source_hash TEXT NOT NULL DEFAULT ''",
      "field_source_hashes TEXT NOT NULL DEFAULT '{}'",
      ...table.columns.map((col) => `${col} TEXT`),
      'created_at TEXT DEFAULT CURRENT_TIMESTAMP',
      'updated_at TEXT DEFAULT CURRENT_TIMESTAMP',
      'UNIQUE(source_id, lang)',
    ].join(',\n        ')

    const sql = `
      CREATE TABLE IF NOT EXISTS ${translationTable} (
        ${columnDefs}
      )
    `

    this.db.run(sql)
    this.ensureMetadataColumns(translationTable)

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
    const selectColumns = [
      idColumn,
      ...table.columns,
      ...(table.langColumn ? [table.langColumn] : []),
    ].join(', ')

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
      sourceLang:
        table.langColumn && row[table.langColumn] != null
          ? String(row[table.langColumn])
          : undefined,
    }))
  }

  async getTranslations(table: TableConfig, suffix: string): Promise<StoredTranslationRow[]> {
    if (!this.db) throw new Error('Database not connected')

    const translationTable = this.getTranslationTableName(table, suffix)

    try {
      const selectColumns = [
        'source_id',
        'lang',
        'source_lang',
        'row_source_hash',
        'field_source_hashes',
        ...table.columns,
      ].join(', ')
      const stmt = this.db.prepare(`SELECT ${selectColumns} FROM ${translationTable}`)
      const translations: StoredTranslationRow[] = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>
        translations.push({
          sourceId: String(row.source_id ?? ''),
          lang: String(row.lang ?? ''),
          sourceLang: String(row.source_lang ?? ''),
          rowSourceHash: String(row.row_source_hash ?? ''),
          fieldSourceHashes: parseFieldHashes(row.field_source_hashes),
          columns: table.columns.reduce((acc, col) => {
            const value = row[col]
            acc[col] = value != null ? String(value) : ''
            return acc
          }, {} as Record<string, string>),
        })
      }
      stmt.free()
      return translations
    } catch {
      return []
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
    const insertColumns = [
      'source_id',
      'lang',
      'source_lang',
      'row_source_hash',
      'field_source_hashes',
      ...columnNames,
    ]
    const columnPlaceholders = insertColumns.map(() => '?').join(', ')
    const updateSet = [
      'source_lang = excluded.source_lang',
      'row_source_hash = excluded.row_source_hash',
      'field_source_hashes = excluded.field_source_hashes',
      ...columnNames.map((col) => `${col} = excluded.${col}`),
    ].join(', ')

    const sql = `
      INSERT INTO ${translationTable} (${insertColumns.join(', ')}, updated_at)
      VALUES (${columnPlaceholders}, CURRENT_TIMESTAMP)
      ON CONFLICT(source_id, lang) DO UPDATE SET
        ${updateSet},
        updated_at = CURRENT_TIMESTAMP
    `

    const values = [
      String(translation.sourceId),
      translation.lang,
      translation.sourceLang,
      translation.rowSourceHash,
      JSON.stringify(translation.fieldSourceHashes),
      ...columnNames.map((col) => translation.columns[col] ?? ''),
    ]

    this.db.run(sql, values)
    this.save()
  }

  private ensureMetadataColumns(translationTable: string): void {
    if (!this.db) throw new Error('Database not connected')

    const columns = this.getExistingColumns(translationTable)

    if (!columns.has('source_lang')) {
      this.db.run(`ALTER TABLE ${translationTable} ADD COLUMN source_lang TEXT NOT NULL DEFAULT ''`)
    }
    if (!columns.has('row_source_hash')) {
      this.db.run(
        `ALTER TABLE ${translationTable} ADD COLUMN row_source_hash TEXT NOT NULL DEFAULT ''`,
      )
    }
    if (!columns.has('field_source_hashes')) {
      this.db.run(
        `ALTER TABLE ${translationTable} ADD COLUMN field_source_hashes TEXT NOT NULL DEFAULT '{}'`,
      )
    }
  }

  private getExistingColumns(tableName: string): Set<string> {
    if (!this.db) throw new Error('Database not connected')

    const stmt = this.db.prepare(`PRAGMA table_info(${tableName})`)
    const columns = new Set<string>()

    while (stmt.step()) {
      const row = stmt.getAsObject() as { name?: string }
      if (row.name) {
        columns.add(row.name)
      }
    }

    stmt.free()
    return columns
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
