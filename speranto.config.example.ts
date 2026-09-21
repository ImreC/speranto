import type { Config } from './src/config'

const config: Config = {
  // LLM Configuration
  model: 'gpt-4o-mini', // or 'mistral-large-latest', 'llama3.2', etc.
  provider: 'openai', // 'openai', 'mistral', 'ollama', or another OpenAI-compatible provider
  apiKey: process.env.OPENAI_API_KEY,
  // baseUrl: 'https://my-llm.example.com/v1',
  concurrency: 5, // Global LLM request limit across every language and source
  timeout: 600_000,
  verbose: false,

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
    // excludeKeys: ['localizedSlug'],
  },

  // Database Translation (optional, can use alongside files)
  // database: {
  //   type: 'postgres',
  //   connection: process.env.DATABASE_URL!,
  //   tables: [
  //     {
  //       name: 'articles',
  //       schema: 'public',
  //       columns: ['title', 'body', 'summary'],
  //       idColumn: 'id',
  //       langColumn: 'lang',
  //     },
  //     {
  //       name: 'products',
  //       columns: ['name', 'description'],
  //     },
  //   ],
  //   translationTableSuffix: '_translations',
  //   concurrency: 10, // Active row jobs; top-level concurrency remains the LLM request limit
  // },

  retranslate: false,
  init: false,
}

export default config
