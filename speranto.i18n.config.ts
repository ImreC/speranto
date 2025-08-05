import type { Config } from './src/types'

const config: Config = {
  model: 'mistral-large-latest',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['nl'],
  sourceDir: './example_content/i18n',
  targetDir: './example_content/i18n',
  provider: 'mistral',
  useLangCodeAsFilename: true,
  apiKey: process.env.MISTRAL_API_KEY,
}

export default config
