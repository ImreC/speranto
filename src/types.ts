import type { LLMInterface } from './interface'

export interface Config {
  model: string
  temperature: number
  sourceLang: string
  targetLangs: string[]
  sourceDir: string
  targetDir: string
  provider: 'openai' | 'ollama' | 'mistral'
  useLangCodeAsFilename?: boolean
  apiKey?: string
  llm?: LLMInterface
  verbose?: boolean
}

export interface TableConfig {
  name: string
  columns: string[]
  idColumn?: string
}

export interface DatabaseConfig {
  type: 'sqlite' | 'postgres' | 'mysql'
  connection: string
  tables: TableConfig[]
  translationTableSuffix?: string
}

export interface DatabaseTranslationConfig {
  model: string
  temperature: number
  sourceLang: string
  targetLangs: string[]
  provider: 'openai' | 'ollama' | 'mistral'
  apiKey?: string
  database: DatabaseConfig
}
