import type { Config } from './src/types'

const config: Config = {
  model: 'gpt-4o-mini',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['es', 'fr', 'de'],
  provider: 'openai',
  database: {
    type: 'sqlite',
    connection: './data.db',
    translationTableSuffix: '_translations',
    tables: [
      {
        name: 'articles',
        columns: ['title', 'body', 'excerpt'],
        idColumn: 'id',
      },
      {
        name: 'categories',
        columns: ['name', 'description'],
        idColumn: 'id',
      },
    ],
  },
}

export default config
