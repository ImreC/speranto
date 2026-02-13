import { Translator } from './translator'
import { ConcurrencyQueue } from './concurrency'
import { ProgressReporter } from './progress'
import { createDatabaseAdapter, type TranslationRow } from './database'
import type { Config, TableConfig } from './types'

interface DatabaseTranslateConfig extends Config {
  database: NonNullable<Config['database']>
}

export async function orchestrateDatabase(
  config: Config,
  queue: ConcurrencyQueue,
  reporter: ProgressReporter,
) {
  if (!config.database) return

  const dbConfig = config as DatabaseTranslateConfig
  const suffix = dbConfig.database.translationTableSuffix || '_translations'
  const adapter = createDatabaseAdapter(dbConfig.database)

  await adapter.connect()

  for (const table of dbConfig.database.tables) {
    await adapter.ensureTranslationTable(table, suffix)
  }

  const totalWork = await countDatabaseWork(adapter, dbConfig, suffix)

  if (totalWork === 0) {
    await adapter.close()
    return
  }

  reporter.databaseHeader(config.sourceLang, config.targetLangs, dbConfig.database.tables.length)

  for (const targetLang of config.targetLangs) {
    const translator = new Translator({
      model: config.model,
      temperature: config.temperature,
      sourceLang: config.sourceLang,
      targetLang,
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      llm: config.llm,
      instructionsDir: config.instructionsDir,
      retranslate: config.retranslate,
    })

    let langTotal = 0
    const workItems: Array<{ label: string; execute: () => Promise<void> }> = []

    for (const table of dbConfig.database.tables) {
      const tableName = table.schema ? `${table.schema}.${table.name}` : table.name
      const sourceRows = await adapter.getSourceRows(table)
      const translatedIds = await adapter.getTranslatedIds(table, targetLang, suffix)
      const rowsToTranslate = sourceRows.filter(
        (row) => !translatedIds.has(String(row.id)),
      )

      for (const row of rowsToTranslate) {
        langTotal++
        workItems.push({
          label: `${tableName} row ${row.id}`,
          execute: async () => {
            const columns = Object.entries(row.columns)
            const columnsToTranslate = columns.filter(
              ([, value]) => typeof value === 'string' && value.trim(),
            )
            const emptyColumns = columns.filter(
              ([, value]) => typeof value !== 'string' || !value.trim(),
            )

            const translatedColumns: Record<string, string> = {}

            for (const [column, value] of emptyColumns) {
              translatedColumns[column] = (value as string) ?? ''
            }

            if (columnsToTranslate.length > 0) {
              const strings = columnsToTranslate.map(([column, value]) => ({
                key: column,
                value: value as string,
              }))

              const translated = await translator.translateGroup(`row_${row.id}`, strings)
              for (const { key, value } of translated) {
                translatedColumns[key] = value
              }
            }

            const translation: TranslationRow = {
              sourceId: row.id,
              lang: targetLang,
              columns: translatedColumns,
            }

            await adapter.upsertTranslation(table, translation, suffix)
          },
        })
      }
    }

    if (workItems.length === 0) {
      reporter.skipLanguage(targetLang, 'all rows translated')
      continue
    }

    reporter.startLanguage(targetLang, langTotal)

    await Promise.all(
      workItems.map((item) =>
        queue.run(async () => {
          try {
            await item.execute()
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            reporter.reportError(targetLang, item.label, error.message)
          }
          reporter.updateProgress()
        }),
      ),
    )

    reporter.finishLanguage()
  }

  await adapter.close()
  reporter.finish()
}

async function countDatabaseWork(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  config: DatabaseTranslateConfig,
  suffix: string,
): Promise<number> {
  let total = 0
  for (const targetLang of config.targetLangs) {
    for (const table of config.database.tables) {
      const sourceRows = await adapter.getSourceRows(table)
      const translatedIds = await adapter.getTranslatedIds(table, targetLang, suffix)
      total += sourceRows.filter((row) => !translatedIds.has(String(row.id))).length
    }
  }
  return total
}
