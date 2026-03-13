import { Listr } from 'listr2'
import {
  createDatabaseAdapter,
  type StoredTranslationRow,
  type TranslationRow,
} from './database'
import { Translator } from './translator'
import { createHashMetadata, type HashEntry } from './util/hash'
import type { Config, TableConfig } from './types'

interface DatabaseTranslateConfig extends Config {
  database: NonNullable<Config['database']>
}

export function orchestrateDatabase(config: Config): Listr {
  if (!config.database) {
    return new Listr([{ title: 'No database configured', task: () => {} }])
  }

  const dbConfig = config as DatabaseTranslateConfig
  const suffix = dbConfig.database.translationTableSuffix || '_translations'
  const concurrency = dbConfig.concurrency ?? dbConfig.database.concurrency ?? 5
  const adapter = createDatabaseAdapter(dbConfig.database)
  const translators = new Map<string, Translator>()

  return new Listr(
    [
      {
        title: 'Connect to database',
        task: async () => {
          await adapter.connect()
        },
      },
      {
        title: 'Ensure translation tables',
        task: () =>
          new Listr(
            dbConfig.database.tables.map((table) => ({
              title: table.schema ? `${table.schema}.${table.name}` : table.name,
              task: async () => {
                await adapter.ensureTranslationTable(table, suffix)
              },
            })),
            { concurrent: true },
          ),
      },
      {
        title: 'Sync translation tables',
        task: (_ctx: unknown, task: any) =>
          task.newListr(
            dbConfig.database.tables.map((table) => ({
              title: table.schema ? `${table.schema}.${table.name}` : table.name,
              task: (_ctx: unknown, tableTask: any) =>
                syncTableTranslations(
                  adapter,
                  table,
                  dbConfig,
                  suffix,
                  concurrency,
                  translators,
                  tableTask,
                ),
            })),
            { concurrent: false },
          ),
      },
      {
        title: 'Close connection',
        task: async () => {
          await adapter.close()
        },
      },
    ],
    { concurrent: false },
  )
}

async function syncTableTranslations(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  config: DatabaseTranslateConfig,
  suffix: string,
  concurrency: number,
  translators: Map<string, Translator>,
  task: any,
) {
  const sourceRows = await adapter.getSourceRows(table)
  const existingTranslations = await adapter.getTranslations(table, suffix)

  if (sourceRows.length === 0) {
    task.skip('no source rows')
    return
  }

  const translationsBySourceId = buildTranslationIndex(existingTranslations)
  task.title = `${table.schema ? `${table.schema}.` : ''}${table.name} (${sourceRows.length} rows)`

  return task.newListr(
    sourceRows.map((row) => ({
      title: `row ${row.id}`,
      task: async (_ctx: unknown, rowTask: any) => {
        const rowTranslations = translationsBySourceId.get(String(row.id)) ?? new Map()
        const sourceLang = row.sourceLang || config.sourceLang
        const sourceEntries = Object.entries(row.columns).map(([key, value]) => ({
          key,
          value,
        }))
        const hashMetadata = createHashMetadata(sourceEntries, sourceLang)

        await syncBaseLanguageRow(
          adapter,
          table,
          row,
          sourceLang,
          hashMetadata,
          rowTranslations.get(sourceLang),
          suffix,
          config.retranslate ?? false,
        )

        const targetLangs = config.targetLangs.filter((targetLang) => targetLang !== sourceLang)

        for (const targetLang of targetLangs) {
          await syncTranslatedRow(
            adapter,
            table,
            row,
            sourceLang,
            targetLang,
            hashMetadata,
            rowTranslations.get(targetLang),
            config,
            translators,
            suffix,
          )
        }

        rowTask.title = `row ${row.id} synced`
      },
    })),
    { concurrent: concurrency, exitOnError: false },
  )
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

async function syncBaseLanguageRow(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  row: { id: string | number; columns: Record<string, string> },
  sourceLang: string,
  hashMetadata: { rowHash: string; fieldHashes: Record<string, string> },
  existing: StoredTranslationRow | undefined,
  suffix: string,
  retranslate: boolean,
): Promise<void> {
  if (!retranslate && existing?.rowSourceHash === hashMetadata.rowHash) {
    return
  }

  const translation: TranslationRow = {
    sourceId: row.id,
    lang: sourceLang,
    sourceLang,
    rowSourceHash: hashMetadata.rowHash,
    fieldSourceHashes: hashMetadata.fieldHashes,
    columns: { ...row.columns },
  }

  await adapter.upsertTranslation(table, translation, suffix)
}

async function syncTranslatedRow(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  row: { id: string | number; columns: Record<string, string> },
  sourceLang: string,
  targetLang: string,
  hashMetadata: { rowHash: string; fieldHashes: Record<string, string> },
  existing: StoredTranslationRow | undefined,
  config: DatabaseTranslateConfig,
  translators: Map<string, Translator>,
  suffix: string,
): Promise<void> {
  if (!config.retranslate && existing?.rowSourceHash === hashMetadata.rowHash) {
    return
  }

  const translatedColumns = buildTranslatedColumns(
    row.columns,
    sourceLang,
    targetLang,
    hashMetadata.fieldHashes,
    existing,
  )

  if (translatedColumns.changed.length > 0) {
    const translator = getTranslator(translators, config, sourceLang, targetLang)
    const translated = await translator.translateGroupWithContext(
      `row_${row.id}`,
      translatedColumns.changed,
      translatedColumns.context,
    )

    for (const { key, value } of translated) {
      translatedColumns.columns[key] = value
    }
  }

  const translation: TranslationRow = {
    sourceId: row.id,
    lang: targetLang,
    sourceLang,
    rowSourceHash: hashMetadata.rowHash,
    fieldSourceHashes: hashMetadata.fieldHashes,
    columns: translatedColumns.columns,
  }

  await adapter.upsertTranslation(table, translation, suffix)
}

function buildTranslatedColumns(
  sourceColumns: Record<string, string>,
  sourceLang: string,
  targetLang: string,
  fieldHashes: Record<string, string>,
  existing: StoredTranslationRow | undefined,
): {
  changed: HashEntry[]
  context: HashEntry[]
  columns: Record<string, string>
} {
  const changed: HashEntry[] = []
  const context: HashEntry[] = []
  const columns: Record<string, string> = {}
  const canReuseExisting = existing && existing.sourceLang === sourceLang

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
    temperature: config.temperature,
    sourceLang,
    targetLang,
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    llm: config.llm,
    instructionsDir: config.instructionsDir,
    retranslate: config.retranslate,
  })

  translators.set(cacheKey, translator)
  return translator
}
