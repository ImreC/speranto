import type { LLMInterface } from './interface'

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

export interface FileConfig {
  sourceDir: string
  targetDir: string
  useLangCodeAsFilename?: boolean
}

export interface Config {
  model: string
  temperature: number
  sourceLang: string
  targetLangs: string[]
  provider: 'openai' | 'ollama' | 'mistral'
  apiKey?: string
  llm?: LLMInterface
  verbose?: boolean
  files?: FileConfig
  database?: DatabaseConfig
}
