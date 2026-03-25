import { Listr } from 'listr2'
import {
  createDatabaseAdapter,
  type DatabaseAdapter,
  type SourceRow,
  type StoredTranslationRow,
  type TranslationRow,
} from './database'
import { Translator } from './translator'
import { createHashMetadata, type HashEntry } from './util/hash'
import type { Config, TableConfig } from './types'

interface DatabaseTranslateConfig extends Config {
  database: NonNullable<Config['database']>
}

interface RowContext {
  row: SourceRow
  sourceLang: string
  hashMetadata: { rowHash: string; fieldHashes: Record<string, string> }
  rowTranslations: Map<string, StoredTranslationRow>
}

function prepareRow(
  row: SourceRow,
  defaultSourceLang: string,
  translationsBySourceId: Map<string, Map<string, StoredTranslationRow>>,
): RowContext {
  const sourceLang = row.sourceLang || defaultSourceLang
  const sourceEntries = Object.entries(row.columns).map(([key, value]) => ({ key, value }))
  const hashMetadata = createHashMetadata(sourceEntries, sourceLang)
  const rowTranslations = translationsBySourceId.get(String(row.id)) ?? new Map()
  return { row, sourceLang, hashMetadata, rowTranslations }
}

export async function orchestrateDatabase(config: Config): Promise<void> {
  if (!config.database) return

  const dbConfig = config as DatabaseTranslateConfig
  const suffix = dbConfig.database.translationTableSuffix || '_translations'
  const concurrency = dbConfig.concurrency ?? dbConfig.database.concurrency ?? 5
  const adapter = createDatabaseAdapter(dbConfig.database)
  const translators = new Map<string, Translator>()

  await adapter.connect()

  for (const table of dbConfig.database.tables) {
    await adapter.ensureTranslationTable(table, suffix)
  }

  const processTable = config.init
    ? (table: TableConfig, targetLang: string, task: any) =>
        initTable(adapter, table, targetLang, suffix, config.sourceLang, task)
    : (table: TableConfig, targetLang: string, task: any) =>
        translateTable(adapter, table, targetLang, suffix, concurrency, dbConfig, translators, task)

  for (const targetLang of dbConfig.targetLangs) {
    const tableTasks = dbConfig.database.tables.map((table) => {
      const tableName = table.schema ? `${table.schema}.${table.name}` : table.name
      return {
        title: tableName,
        task: (_ctx: unknown, task: any) => processTable(table, targetLang, task),
      }
    })

    const listr = new Listr(tableTasks, {
      concurrent: false,
      exitOnError: false,
      rendererOptions: { collapseSubtasks: true },
    } as any)

    console.log(`\nDatabase → ${targetLang}`)
    await listr.run()
  }

  await adapter.close()
}

async function initTable(
  adapter: DatabaseAdapter,
  table: TableConfig,
  targetLang: string,
  suffix: string,
  defaultSourceLang: string,
  task: any,
): Promise<void> {
  const sourceRows = await adapter.getSourceRows(table)
  const existingTranslations = await adapter.getTranslations(table, suffix)

  if (sourceRows.length === 0) {
    task.skip('no source rows')
    return
  }

  const translationsBySourceId = buildTranslationIndex(existingTranslations)
  const tableName = table.schema ? `${table.schema}.${table.name}` : table.name
  const pendingUpserts: TranslationRow[] = []

  for (let i = 0; i < sourceRows.length; i++) {
    const ctx = prepareRow(sourceRows[i]!, defaultSourceLang, translationsBySourceId)

    // Always write base row on init (stamps hash)
    const baseRow = buildBaseLanguageRow(ctx, true)
    if (baseRow) pendingUpserts.push(baseRow)

    // Stamp hashes on existing translations
    for (const lang of [targetLang].filter((l) => l !== ctx.sourceLang)) {
      const existing = ctx.rowTranslations.get(lang)
      if (existing) {
        pendingUpserts.push({
          ...existing,
          rowSourceHash: ctx.hashMetadata.rowHash,
          fieldSourceHashes: ctx.hashMetadata.fieldHashes,
        })
      }
    }

    task.title = `${tableName} — ${i + 1}/${sourceRows.length} rows`
  }

  if (pendingUpserts.length > 0) {
    await adapter.upsertTranslations(table, pendingUpserts, suffix)
  }

  task.title = `${tableName} — ${sourceRows.length} rows`
}

async function translateTable(
  adapter: DatabaseAdapter,
  table: TableConfig,
  targetLang: string,
  suffix: string,
  concurrency: number,
  config: DatabaseTranslateConfig,
  translators: Map<string, Translator>,
  task: any,
): Promise<void> {
  const sourceRows = await adapter.getSourceRows(table)
  const existingTranslations = await adapter.getTranslations(table, suffix)

  if (sourceRows.length === 0) {
    task.skip('no source rows')
    return
  }

  const translationsBySourceId = buildTranslationIndex(existingTranslations)
  const tableName = table.schema ? `${table.schema}.${table.name}` : table.name
  let done = 0
  const pendingBaseRows: TranslationRow[] = []

  await runConcurrent(sourceRows, concurrency, async (row) => {
    const ctx = prepareRow(row, config.sourceLang, translationsBySourceId)

    const baseRow = buildBaseLanguageRow(ctx, config.retranslate ?? false)
    if (baseRow) pendingBaseRows.push(baseRow)

    for (const lang of [targetLang].filter((l) => l !== ctx.sourceLang)) {
      const translatedRow = await buildTranslatedRow(ctx, lang, config, translators)
      if (translatedRow) {
        await adapter.upsertTranslation(table, translatedRow, suffix)
      }
    }

    done++
    task.title = `${tableName} — ${done}/${sourceRows.length} rows`
  })

  if (pendingBaseRows.length > 0) {
    await adapter.upsertTranslations(table, pendingBaseRows, suffix)
  }

  task.title = `${tableName} — ${sourceRows.length} rows`
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const errors: Error[] = []
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      try {
        await fn(items[current]!)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })
  await Promise.all(workers)
  if (errors.length > 0) {
    const msg = `${errors.length} item(s) failed: ${errors.map((e) => e.message).join('; ')}`
    console.warn(msg)
  }
}

function buildTranslationIndex(
  translations: StoredTranslationRow[],
): Map<string, Map<string, StoredTranslationRow>> {
  const bySourceId = new Map<string, Map<string, StoredTranslationRow>>()

  for (const translation of translations) {
    const sourceId = String(translation.sourceId)
    if (!bySourceId.has(sourceId)) {
      bySourceId.set(sourceId, new Map())
    }
    bySourceId.get(sourceId)!.set(translation.lang, translation)
  }

  return bySourceId
}

function buildBaseLanguageRow(
  ctx: RowContext,
  forceWrite: boolean,
): TranslationRow | null {
  const existing = ctx.rowTranslations.get(ctx.sourceLang)
  if (!forceWrite && existing?.rowSourceHash === ctx.hashMetadata.rowHash) {
    return null
  }

  return {
    sourceId: ctx.row.id,
    lang: ctx.sourceLang,
    sourceLang: ctx.sourceLang,
    rowSourceHash: ctx.hashMetadata.rowHash,
    fieldSourceHashes: ctx.hashMetadata.fieldHashes,
    columns: { ...ctx.row.columns },
  }
}

async function buildTranslatedRow(
  ctx: RowContext,
  targetLang: string,
  config: DatabaseTranslateConfig,
  translators: Map<string, Translator>,
): Promise<TranslationRow | null> {
  const existing = ctx.rowTranslations.get(targetLang)
  if (!config.retranslate && existing?.rowSourceHash === ctx.hashMetadata.rowHash) {
    return null
  }

  const translatedColumns = buildTranslatedColumns(
    ctx.row.columns,
    ctx.sourceLang,
    ctx.hashMetadata.fieldHashes,
    existing,
    config.retranslate ?? false,
  )

  if (translatedColumns.changed.length > 0) {
    const translator = getTranslator(translators, config, ctx.sourceLang, targetLang)
    const translated = await translator.translateGroupWithContext(
      `row_${ctx.row.id}`,
      translatedColumns.changed,
      translatedColumns.context,
    )

    for (const { key, value } of translated) {
      translatedColumns.columns[key] = value
    }
  }

  return {
    sourceId: ctx.row.id,
    lang: targetLang,
    sourceLang: ctx.sourceLang,
    rowSourceHash: ctx.hashMetadata.rowHash,
    fieldSourceHashes: ctx.hashMetadata.fieldHashes,
    columns: translatedColumns.columns,
  }
}

function buildTranslatedColumns(
  sourceColumns: Record<string, string>,
  sourceLang: string,
  fieldHashes: Record<string, string>,
  existing: StoredTranslationRow | undefined,
  retranslate: boolean,
): {
  changed: HashEntry[]
  context: HashEntry[]
  columns: Record<string, string>
} {
  const changed: HashEntry[] = []
  const context: HashEntry[] = []
  const columns: Record<string, string> = {}
  const canReuseExisting = !retranslate && existing && existing.sourceLang === sourceLang

  for (const [key, value] of Object.entries(sourceColumns)) {
    const isBlank = !value.trim()

    if (isBlank) {
      columns[key] = value
      continue
    }

    const currentHash = fieldHashes[key]
    const existingHash = canReuseExisting ? existing.fieldSourceHashes[key] : undefined
    const existingValue = canReuseExisting ? existing.columns[key] : undefined

    if (existingHash && existingHash === currentHash && existingValue !== undefined) {
      context.push({ key, value: existingValue })
      columns[key] = existingValue
      continue
    }

    changed.push({ key, value })
  }

  for (const { key, value } of changed) {
    columns[key] = value
  }

  return { changed, context, columns }
}

function getTranslator(
  translators: Map<string, Translator>,
  config: DatabaseTranslateConfig,
  sourceLang: string,
  targetLang: string,
): Translator {
  const cacheKey = `${sourceLang}->${targetLang}`
  const existing = translators.get(cacheKey)
  if (existing) {
    return existing
  }

  const translator = new Translator({
    model: config.model,
    sourceLang,
    targetLang,
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeout: config.timeout,
    llm: config.llm,
    instructionsDir: config.instructionsDir,
    retranslate: config.retranslate,
  })

  translators.set(cacheKey, translator)
  return translator
}
