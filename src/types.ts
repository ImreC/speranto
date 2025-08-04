export interface Config {
  model: string
  temperature: number
  sourceLang: string
  targetLangs: string[]
  sourceDir: string
  targetDir: string
  provider?: 'openai' | 'ollama' | 'mistral'
}
