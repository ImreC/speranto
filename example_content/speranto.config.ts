import type { Config } from '../src/config'

const config: Config = {
  model: 'gpt-5-nano',
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,

  sourceLang: 'en',
  targetLangs: ['es', 'nl'],

  instructionsDir: '../instructions',

  files: {
    sourceDir: './i18n',
    targetDir: './i18n',
    useLangCodeAsFilename: true,
  },

  database: {
    type: 'sqlite',
    connection: './example.db',
    tables: [
      {
        name: 'articles',
        columns: ['title', 'summary', 'body'],
        langColumn: 'lang',
      },
      {
        name: 'products',
        columns: ['name', 'description'],
      },
    ],
  },
}

export default config
