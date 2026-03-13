import { Listr } from 'listr2'
import { Translator } from './translator'
import { createDatabaseAdapter, type TranslationRow } from './database'
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
        title: 'Translate tables',
        task: (_ctx: unknown, task: any) =>
          task.newListr(
            dbConfig.targetLangs.map((targetLang) => ({
              title: targetLang,
              task: (_ctx: unknown, langTask: any) =>
                langTask.newListr(
                  dbConfig.database.tables.map((table) => ({
                    title: table.schema ? `${table.schema}.${table.name}` : table.name,
                    task: (_ctx: unknown, tableTask: any) =>
                      translateTableForLang(
                        adapter,
                        table,
                        targetLang,
                        dbConfig,
                        suffix,
                        concurrency,
                        tableTask,
                      ),
                  })),
                  { concurrent: false },
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

async function translateTableForLang(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  targetLang: string,
  config: DatabaseTranslateConfig,
  suffix: string,
  concurrency: number,
  task: any,
) {
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

  const sourceRows = await adapter.getSourceRows(table)
  const translatedIds = await adapter.getTranslatedIds(table, targetLang, suffix)
  const rowsToTranslate = sourceRows.filter((row) => !translatedIds.has(String(row.id)))

  if (rowsToTranslate.length === 0) {
    task.skip('all rows translated')
    return
  }

  const total = rowsToTranslate.length
  let completed = 0

  task.title = `${table.schema ? `${table.schema}.` : ''}${table.name} (${total} rows)`

  return task.newListr(
    rowsToTranslate.map((row) => ({
      title: `row ${row.id}`,
      task: async (_ctx: unknown, rowTask: any) => {
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
        completed++
        rowTask.title = `row ${row.id} done`
      },
    })),
    { concurrent: concurrency, exitOnError: false },
  )
}
