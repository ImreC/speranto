import type { TableConfig } from '../types'

export interface SourceRow {
  id: string | number
  columns: Record<string, string>
  sourceLang?: string
}

export interface TranslationRow {
  sourceId: string | number
  lang: string
  sourceLang: string
  rowSourceHash: string
  fieldSourceHashes: Record<string, string>
  columns: Record<string, string>
}

export interface StoredTranslationRow extends TranslationRow {}

export abstract class DatabaseAdapter {
  abstract connect(): Promise<void>
  abstract close(): Promise<void>

  abstract ensureTranslationTable(table: TableConfig, suffix: string): Promise<void>

  abstract getSourceRows(table: TableConfig): Promise<SourceRow[]>

  abstract getTranslations(
    table: TableConfig,
    suffix: string,
  ): Promise<StoredTranslationRow[]>

  abstract upsertTranslation(
    table: TableConfig,
    translation: TranslationRow,
    suffix: string,
  ): Promise<void>
}
