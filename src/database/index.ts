export { DatabaseAdapter, type SourceRow, type TranslationRow } from './adapter'
export { SQLiteAdapter } from './sqlite'
export { PostgresAdapter } from './postgres'

import type { DatabaseConfig } from '../types'
import { DatabaseAdapter } from './adapter'
import { SQLiteAdapter } from './sqlite'
import { PostgresAdapter } from './postgres'

export function createDatabaseAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case 'sqlite':
      return new SQLiteAdapter(config.connection)
    case 'postgres':
      return new PostgresAdapter(config.connection)
    case 'mysql':
      throw new Error('MySQL adapter not yet implemented')
    default:
      throw new Error(`Unknown database type: ${config.type}`)
  }
}
