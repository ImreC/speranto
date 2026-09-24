import { createDatabaseAdapter, type TranslationKey } from './database'
import type { DatabaseConfig, TableConfig } from './config'

export interface DatabaseCleanupConfig {
  sourceLang: string
  targetLangs: string[]
  database: DatabaseConfig
}

export interface TableCleanupPlan {
  table: TableConfig
  translations: TranslationKey[]
}

export interface DatabaseCleanupPlan {
  tables: TableCleanupPlan[]
  total: number
}

export interface DatabaseCleanupResult extends DatabaseCleanupPlan {
  approved: boolean
}

export async function cleanupDatabase(
  config: DatabaseCleanupConfig,
  confirm: (plan: DatabaseCleanupPlan) => Promise<boolean>,
): Promise<DatabaseCleanupResult> {
  const adapter = createDatabaseAdapter(config.database)
  const suffix = config.database.translationTableSuffix || '_translations'

  await adapter.connect()
  try {
    const tables = await Promise.all(
      config.database.tables.map(async (table): Promise<TableCleanupPlan> => {
        const [sourceRows, translations] = await Promise.all([
          adapter.getSourceRows(table),
          adapter.getTranslations(table, suffix),
        ])
        const expectedLanguages = new Map<string, Set<string>>()

        for (const row of sourceRows) {
          expectedLanguages.set(
            String(row.id),
            new Set([row.sourceLang || config.sourceLang, ...config.targetLangs]),
          )
        }

        return {
          table,
          translations: translations
            .filter((translation) => {
              const languages = expectedLanguages.get(String(translation.sourceId))
              return !languages?.has(translation.lang)
            })
            .map(({ sourceId, lang }) => ({ sourceId, lang })),
        }
      }),
    )
    const plan = {
      tables,
      total: tables.reduce((total, table) => total + table.translations.length, 0),
    }

    if (plan.total === 0) {
      return { ...plan, approved: false }
    }

    const approved = await confirm(plan)
    if (!approved) {
      return { ...plan, approved: false }
    }

    for (const tablePlan of plan.tables) {
      await adapter.deleteTranslations(tablePlan.table, tablePlan.translations, suffix)
    }

    return { ...plan, approved: true }
  } finally {
    await adapter.close()
  }
}
