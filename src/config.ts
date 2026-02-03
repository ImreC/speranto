/**
 * Configuration types for Speranto translation tool.
 * @module
 */

/**
 * Configuration for a database table to translate.
 */
export interface TableConfig {
  /** Table name */
  name: string
  /** Schema name (PostgreSQL only, defaults to 'public') */
  schema?: string
  /** Column names to translate */
  columns: string[]
  /** Primary key column (defaults to 'id') */
  idColumn?: string
}

/**
 * Database translation configuration.
 */
export interface DatabaseConfig {
  /** Database type */
  type: 'sqlite' | 'postgres' | 'mysql'
  /** Connection string (file path for SQLite, URL for PostgreSQL) */
  connection: string
  /** Tables to translate */
  tables: TableConfig[]
  /** Suffix for translation tables (defaults to '_translations') */
  translationTableSuffix?: string
  /** Number of concurrent row translations (defaults to 10) */
  concurrency?: number
}

/**
 * File translation configuration.
 */
export interface FileConfig {
  /** Directory containing source files */
  sourceDir: string
  /** Output directory pattern (use [lang] as placeholder) */
  targetDir: string
  /** Use language code as filename (e.g., en.json → es.json) */
  useLangCodeAsFilename?: boolean
  /** Maximum strings per translation batch */
  maxStringsPerGroup?: number
}

/**
 * Main configuration for Speranto.
 *
 * @example
 * ```ts
 * import type { Config } from '@speranto/speranto'
 *
 * const config: Config = {
 *   model: 'gpt-4o-mini',
 *   temperature: 0.0,
 *   sourceLang: 'en',
 *   targetLangs: ['es', 'fr', 'de'],
 *   provider: 'openai',
 *   files: {
 *     sourceDir: './content',
 *     targetDir: './content/[lang]',
 *   },
 * }
 *
 * export default config
 * ```
 */
export interface Config {
  /** AI model to use for translation */
  model: string
  /** Temperature setting (0.0 - 1.0) */
  temperature: number
  /** Source language code (e.g., 'en') */
  sourceLang: string
  /** Target language codes */
  targetLangs: string[]
  /** LLM provider */
  provider: 'openai' | 'ollama' | 'mistral'
  /** API key for the LLM provider */
  apiKey?: string
  /** Enable verbose output */
  verbose?: boolean
  /** Directory containing language-specific instruction files */
  instructionsDir?: string
  /** File translation configuration */
  files?: FileConfig
  /** Database translation configuration */
  database?: DatabaseConfig
  /** Force retranslation of all values, even if already translated */
  retranslate?: boolean
  /** Process all translations sequentially (no concurrency) */
  sequential?: boolean
}
