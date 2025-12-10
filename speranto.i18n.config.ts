import type { Config } from './src/types'

const config: Config = {
  model: 'mistral-large-latest',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['nl'],
  provider: 'mistral',
  apiKey: process.env.MISTRAL_API_KEY,
  files: {
    sourceDir: './example_content/i18n',
    targetDir: './example_content/i18n',
    useLangCodeAsFilename: true,
  },
}

export default config
