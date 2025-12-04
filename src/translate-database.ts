import { Translator } from './translator'
import { createDatabaseAdapter, type TranslationRow } from './database'
import type { DatabaseTranslationConfig, TableConfig } from './types'

export async function translateDatabase(config: DatabaseTranslationConfig) {
  const suffix = config.database.translationTableSuffix || '_translations'
  const adapter = createDatabaseAdapter(config.database)

  try {
    await adapter.connect()
    console.log(`Connected to ${config.database.type} database`)

    for (const table of config.database.tables) {
      await ensureTranslationTableExists(adapter, table, suffix)
    }

    for (const targetLang of config.targetLangs) {
      console.log(`\nTranslating to ${targetLang}...`)

      const translator = new Translator({
        model: config.model,
        temperature: config.temperature,
        sourceLang: config.sourceLang,
        targetLang: targetLang,
        provider: config.provider,
        apiKey: config.apiKey,
      })

      for (const table of config.database.tables) {
        await translateTable(adapter, table, targetLang, translator, suffix)
      }
    }

    console.log('\nDatabase translation complete!')
  } finally {
    await adapter.close()
  }
}

async function ensureTranslationTableExists(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  suffix: string,
) {
  const idColumn = table.idColumn || 'id'
  await adapter.ensureTranslationTable(table.name, table.columns, idColumn, suffix)

  const translationTableName = adapter.getTranslationTableName(table.name, suffix)
  console.log(`Ensured translation table exists: ${translationTableName}`)
}

async function translateTable(
  adapter: ReturnType<typeof createDatabaseAdapter>,
  table: TableConfig,
  targetLang: string,
  translator: Translator,
  suffix: string,
) {
  console.log(`\nProcessing table: ${table.name}`)

  const sourceRows = await adapter.getSourceRows(table)
  console.log(`Found ${sourceRows.length} rows to translate`)

  let translatedCount = 0
  let skippedCount = 0

  for (const row of sourceRows) {
    const existing = await adapter.getExistingTranslation(table.name, row.id, targetLang, suffix)

    if (existing) {
      skippedCount++
      continue
    }

    const translatedColumns: Record<string, string> = {}

    for (const [column, value] of Object.entries(row.columns)) {
      if (!value || !value.trim()) {
        translatedColumns[column] = value || ''
        continue
      }

      try {
        const translated = await translator.translateText(value)
        translatedColumns[column] = translated
      } catch (error) {
        console.error(`Error translating ${table.name}.${column} for row ${row.id}:`, error)
        translatedColumns[column] = value
      }
    }

    const translation: TranslationRow = {
      sourceId: row.id,
      lang: targetLang,
      columns: translatedColumns,
    }

    await adapter.upsertTranslation(table.name, translation, suffix)
    translatedCount++

    console.log(`Translated row ${row.id} -> ${targetLang}`)
  }

  console.log(
    `Table ${table.name}: ${translatedCount} translated, ${skippedCount} skipped (already exist)`,
  )
}
