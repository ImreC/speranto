import type { LLMInterface } from './interface'

export interface TableConfig {
  name: string
  schema?: string
  columns: string[]
  idColumn?: string
}

export interface DatabaseConfig {
  type: 'sqlite' | 'postgres' | 'mysql'
  connection: string
  tables: TableConfig[]
  translationTableSuffix?: string
  concurrency?: number
}

export interface FileConfig {
  sourceDir: string
  targetDir: string
  useLangCodeAsFilename?: boolean
  maxStringsPerGroup?: number
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
  instructionsDir?: string
  files?: FileConfig
  database?: DatabaseConfig
}
