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
              title: table.name,
              task: async () => {
                const idColumn = table.idColumn || 'id'
                await adapter.ensureTranslationTable(table.name, table.columns, idColumn, suffix)
              },
            })),
            { concurrent: true },
          ),
      },
      {
        title: 'Translate tables',
        task: () =>
          new Listr(
            dbConfig.targetLangs.map((targetLang) => ({
              title: targetLang,
              task: () => {
                const translator = new Translator({
                  model: dbConfig.model,
                  temperature: dbConfig.temperature,
                  sourceLang: dbConfig.sourceLang,
                  targetLang: targetLang,
                  provider: dbConfig.provider,
                  apiKey: dbConfig.apiKey,
                })

                return new Listr(
                  dbConfig.database.tables.map((table) => ({
                    title: table.name,
                    task: (_ctx, task) =>
                      translateTableTask(adapter, table, targetLang, translator, suffix, task),
                  })),
                  { concurrent: false },
                )
              },
            })),
            { concurrent: true },
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

async function translateTableTask(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  targetLang: string,
  translator: Translator,
  suffix: string,
  task: any,
): Promise<Listr> {
  const sourceRows = await adapter.getSourceRows(table)

  const rowsToTranslate: typeof sourceRows = []
  let skippedCount = 0

  for (const row of sourceRows) {
    const existing = await adapter.getExistingTranslation(table.name, row.id, targetLang, suffix)
    if (existing) {
      skippedCount++
    } else {
      rowsToTranslate.push(row)
    }
  }

  if (rowsToTranslate.length === 0) {
    task.skip(`${skippedCount} rows already translated`)
    return new Listr([])
  }

  task.title = `${table.name} (${rowsToTranslate.length} rows, ${skippedCount} skipped)`

  return new Listr(
    rowsToTranslate.map((row) => ({
      title: `Row ${row.id}`,
      task: async () => {
        const translatedColumns: Record<string, string> = {}

        for (const [column, value] of Object.entries(row.columns)) {
          if (!value || !value.trim()) {
            translatedColumns[column] = value || ''
            continue
          }

          const translated = await translator.translateText(value)
          translatedColumns[column] = translated
        }

        const translation: TranslationRow = {
          sourceId: row.id,
          lang: targetLang,
          columns: translatedColumns,
        }

        await adapter.upsertTranslation(table.name, translation, suffix)
      },
    })),
    { concurrent: false },
  )
}
