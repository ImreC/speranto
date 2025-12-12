import type { TableConfig } from '../types'

export interface SourceRow {
  id: string | number
  columns: Record<string, string>
}

export interface TranslationRow {
  sourceId: string | number
  lang: string
  columns: Record<string, string>
}

export abstract class DatabaseAdapter {
  abstract connect(): Promise<void>
  abstract close(): Promise<void>

  abstract ensureTranslationTable(table: TableConfig, suffix: string): Promise<void>

  abstract getSourceRows(table: TableConfig): Promise<SourceRow[]>

  abstract getTranslatedIds(
    table: TableConfig,
    lang: string,
    suffix: string,
  ): Promise<Set<string>>

  abstract upsertTranslation(
    table: TableConfig,
    translation: TranslationRow,
    suffix: string,
  ): Promise<void>
}
