import { Listr } from 'listr2'
import { Translator } from './translator'
import { createDatabaseAdapter, type TranslationRow } from './database'
import type { Config, TableConfig } from './types'

interface DatabaseConfig extends Config {
  database: NonNullable<Config['database']>
}

export function translateDatabaseTasks(config: Config): Listr {
  if (!config.database) {
    return new Listr([{ title: 'No database configured', task: () => {} }])
  }

  const dbConfig = config as DatabaseConfig
  const suffix = dbConfig.database.translationTableSuffix || '_translations'
  const concurrency = dbConfig.sequential ? 1 : (dbConfig.database.concurrency || DEFAULT_CONCURRENCY)
  const adapter = createDatabaseAdapter(dbConfig.database)

  const translators = new Map(
    dbConfig.targetLangs.map((lang) => [
      lang,
      new Translator({
        model: dbConfig.model,
        temperature: dbConfig.temperature,
        sourceLang: dbConfig.sourceLang,
        targetLang: lang,
        provider: dbConfig.provider,
        apiKey: dbConfig.apiKey,
        instructionsDir: dbConfig.instructionsDir,
      }),
    ]),
  )

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
            { concurrent: !dbConfig.sequential },
          ),
      },
      {
        title: `Translate tables (concurrency: ${concurrency})`,
        task: () =>
          new Listr(
            dbConfig.database.tables.map((table) => ({
              title: table.schema ? `${table.schema}.${table.name}` : table.name,
              task: (_ctx, tableTask) =>
                tableTask.newListr(
                  dbConfig.targetLangs.map((targetLang) => ({
                    title: targetLang,
                    task: (_ctx, langTask) =>
                      translateTableTask(
                        adapter,
                        table,
                        targetLang,
                        translators.get(targetLang)!,
                        suffix,
                        concurrency,
                        langTask,
                      ),
                  })),
                  { concurrent: !dbConfig.sequential },
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

const DEFAULT_CONCURRENCY = 10

async function translateTableTask(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  targetLang: string,
  translator: Translator,
  suffix: string,
  concurrency: number,
  task: any,
): Promise<Listr> {
  return task.newListr(
    [
      {
        title: `${targetLang}: fetching data...`,
        task: async (ctx: any, fetchTask: any) => {
          fetchTask.title = `${targetLang}: fetching source rows...`
          const sourceRowsPromise = adapter.getSourceRows(table)

          fetchTask.title = `${targetLang}: fetching existing translations...`
          const translatedIdsPromise = adapter.getTranslatedIds(table, targetLang, suffix)

          const [sourceRows, translatedIds] = await Promise.all([
            sourceRowsPromise,
            translatedIdsPromise,
          ])

          ctx.sourceRows = sourceRows
          ctx.translatedIds = translatedIds
          fetchTask.title = `${targetLang}: found ${sourceRows.length} rows`
        },
      },
      {
        title: `${targetLang}: translating...`,
        task: async (ctx: any, translateTask: any) => {
          const rowsToTranslate = ctx.sourceRows.filter(
            (row: any) => !ctx.translatedIds.has(String(row.id)),
          )
          const skippedCount = ctx.sourceRows.length - rowsToTranslate.length

          if (rowsToTranslate.length === 0) {
            translateTask.skip(`${skippedCount} rows already translated`)
            return
          }

          const total = rowsToTranslate.length
          let completed = 0
          let inProgress = 0

          const updateTitle = () => {
            const skippedText = skippedCount > 0 ? ` (${skippedCount} skipped)` : ''
            const inProgressText = inProgress > 0 ? `, ${inProgress} in progress` : ''
            translateTask.title =
              `${targetLang}: ${completed}/${total} rows${inProgressText}${skippedText}`
          }

          updateTitle()

          const translateRow = async (row: (typeof rowsToTranslate)[number]) => {
            inProgress++
            updateTitle()

            const columns = Object.entries(row.columns)
            const columnsToTranslate = columns.filter(
              ([, value]) => typeof value === 'string' && value.trim(),
            )
            const emptyColumns = columns.filter(
              ([, value]) => typeof value !== 'string' || !value.trim(),
            )

            const translatedColumns: Record<string, string> = {}

            // Keep empty/non-string columns as-is
            for (const [column, value] of emptyColumns) {
              translatedColumns[column] = (value as string) ?? ''
            }

            // Batch translate all non-empty columns in a single LLM call
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
            inProgress--
            completed++
            updateTitle()
          }

          const chunks: typeof rowsToTranslate[] = []
          for (let i = 0; i < rowsToTranslate.length; i += concurrency) {
            chunks.push(rowsToTranslate.slice(i, i + concurrency))
          }

          for (const chunk of chunks) {
            await Promise.all(chunk.map(translateRow))
          }
        },
      },
    ],
    { concurrent: false },
  )
}
