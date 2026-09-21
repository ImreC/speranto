import {
  createDatabaseAdapter,
  type DatabaseAdapter,
  type SourceRow,
  type StoredTranslationRow,
  type TranslationRow,
} from './database'
import { Translator } from './translator'
import { resolveConcurrency } from './util/concurrency'
import { RequestScheduler } from './execution/scheduler'
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

export async function orchestrateDatabase(
  config: Config,
  scheduler: RequestScheduler,
): Promise<void> {
  if (!config.database) return

  const dbConfig = config as DatabaseTranslateConfig
  const suffix = dbConfig.database.translationTableSuffix || '_translations'
  const databaseConcurrency = dbConfig.database.concurrency
  const concurrency = resolveConcurrency(
    databaseConcurrency ?? dbConfig.concurrency,
    10,
    databaseConcurrency === undefined ? 'concurrency' : 'database.concurrency',
  )
  const adapter = createDatabaseAdapter(dbConfig.database)
  const translators = new Map<string, Translator>()

  await adapter.connect()
  try {
    for (const table of dbConfig.database.tables) {
      await adapter.ensureTranslationTable(table, suffix)
    }

    const processTable = config.init
      ? (table: TableConfig) =>
          initTable(adapter, table, dbConfig.targetLangs, suffix, config.sourceLang)
      : (table: TableConfig) =>
          translateTable(
            adapter,
            table,
            dbConfig.targetLangs,
            suffix,
            concurrency,
            dbConfig,
            translators,
            scheduler,
          )

    const results = await Promise.allSettled(
      dbConfig.database.tables.map((table) => processTable(table)),
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) =>
        result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
      )
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} table(s) failed: ${errors.map((error) => error.message).join('; ')}`,
      )
    }
  } finally {
    await adapter.close()
  }
}

async function initTable(
  adapter: DatabaseAdapter,
  table: TableConfig,
  targetLangs: string[],
  suffix: string,
  defaultSourceLang: string,
): Promise<void> {
  const sourceRows = await adapter.getSourceRows(table)
  const existingTranslations = await adapter.getTranslations(table, suffix)

  if (sourceRows.length === 0) {
    return
  }

  const translationsBySourceId = buildTranslationIndex(existingTranslations)
  const pendingUpserts: TranslationRow[] = []

  for (let i = 0; i < sourceRows.length; i++) {
    const ctx = prepareRow(sourceRows[i]!, defaultSourceLang, translationsBySourceId)

    // Always write base row on init (stamps hash)
    const baseRow = buildBaseLanguageRow(ctx, true)
    if (baseRow) pendingUpserts.push(baseRow)

    // Stamp hashes on existing translations
    for (const lang of targetLangs.filter((targetLang) => targetLang !== ctx.sourceLang)) {
      const existing = ctx.rowTranslations.get(lang)
      if (existing) {
        pendingUpserts.push({
          ...existing,
          rowSourceHash: ctx.hashMetadata.rowHash,
          fieldSourceHashes: ctx.hashMetadata.fieldHashes,
        })
      }
    }
  }

  if (pendingUpserts.length > 0) {
    await adapter.upsertTranslations(table, pendingUpserts, suffix)
  }
}

async function translateTable(
  adapter: DatabaseAdapter,
  table: TableConfig,
  targetLangs: string[],
  suffix: string,
  concurrency: number,
  config: DatabaseTranslateConfig,
  translators: Map<string, Translator>,
  scheduler: RequestScheduler,
): Promise<void> {
  const sourceRows = await adapter.getSourceRows(table)
  const existingTranslations = await adapter.getTranslations(table, suffix)

  if (sourceRows.length === 0) {
    return
  }

  const translationsBySourceId = buildTranslationIndex(existingTranslations)
  const pendingBaseRows: TranslationRow[] = []

  await runConcurrent(sourceRows, concurrency, async (row) => {
    const ctx = prepareRow(row, config.sourceLang, translationsBySourceId)

    const baseRow = buildBaseLanguageRow(ctx, config.retranslate ?? false)
    if (baseRow) pendingBaseRows.push(baseRow)

    await Promise.all(
      targetLangs
        .filter((targetLang) => targetLang !== ctx.sourceLang)
        .map(async (targetLang) => {
          const translatedRow = await buildTranslatedRow(
            ctx,
            targetLang,
            config,
            translators,
            scheduler,
          )
          if (translatedRow) {
            await adapter.upsertTranslation(table, translatedRow, suffix)
          }
        }),
    )
  })

  if (pendingBaseRows.length > 0) {
    await adapter.upsertTranslations(table, pendingBaseRows, suffix)
  }
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
    throw new AggregateError(errors, msg)
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

function buildBaseLanguageRow(ctx: RowContext, forceWrite: boolean): TranslationRow | null {
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
  scheduler: RequestScheduler,
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
    const translator = getTranslator(
      translators,
      config,
      ctx.sourceLang,
      targetLang,
      scheduler,
    )
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
  scheduler: RequestScheduler,
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
    scheduler,
    job: {
      id: `database:${sourceLang}:${targetLang}`,
      label: `Database ${sourceLang} → ${targetLang}`,
      source: 'database',
      targetLang,
    },
  })

  translators.set(cacheKey, translator)
  return translator
}
