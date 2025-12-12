import type { Config } from './src/config'

const config: Config = {
  // LLM Configuration
  model: 'gpt-4o-mini', // or 'mistral-large-latest', 'llama3.2', etc.
  temperature: 0.0, // 0.0 for consistent translations, higher for more creative
  provider: 'openai', // 'openai' | 'mistral' | 'ollama'
  apiKey: process.env.OPENAI_API_KEY,

  // Language Settings
  sourceLang: 'en',
  targetLangs: ['es', 'fr', 'de', 'nl'],

  // Optional: Custom translation instructions per language
  // Create files like ./instructions/es.md, ./instructions/fr.md
  instructionsDir: './instructions',

  // File Translation
  files: {
    sourceDir: './src/i18n/languages',
    targetDir: './src/i18n/languages', // Use same dir with useLangCodeAsFilename
    useLangCodeAsFilename: true, // en.json -> es.json, fr.json, etc.
    maxStringsPerGroup: 200, // Split large files into smaller batches
  },

  // Database Translation (optional, can use alongside files)
  // database: {
  //   type: 'postgres',
  //   connection: process.env.DATABASE_URL,
  //   tables: [
  //     {
  //       name: 'articles',
  //       schema: 'public',
  //       columns: ['title', 'body', 'summary'],
  //       idColumn: 'id',
  //     },
  //     {
  //       name: 'products',
  //       columns: ['name', 'description'],
  //     },
  //   ],
  //   translationTableSuffix: '_translations',
  //   concurrency: 10,
  // },
}

export default config
