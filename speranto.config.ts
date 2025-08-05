import type { Config } from './src/types'

const config: Config = {
  model: 'mistral-large-latest',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['nl'],
  sourceDir: './example_content/content/blog/en',
  targetDir: './example_content/content/blog/[lang]',
  provider: 'mistral',
  apiKey: process.env.MISTRAL_API_KEY,
}

export default config
