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
  const concurrency = dbConfig.database.concurrency || DEFAULT_CONCURRENCY
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
        title: `Translate tables (concurrency: ${concurrency})`,
        task: () =>
          new Listr(
            dbConfig.database.tables.map((table) => ({
              title: table.name,
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
                  { concurrent: true },
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
): Promise<void> {
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
    return
  }

  const total = rowsToTranslate.length
  let completed = 0

  const updateTitle = () => {
    task.title = `${targetLang}: ${completed}/${total} rows` +
      (skippedCount > 0 ? ` (${skippedCount} skipped)` : '')
  }

  updateTitle()

  const translateRow = async (row: (typeof rowsToTranslate)[number]) => {
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
}
