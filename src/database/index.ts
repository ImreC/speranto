export { DatabaseAdapter, type SourceRow, type TranslationRow } from './adapter'
export { SQLiteAdapter } from './sqlite'

import type { DatabaseConfig } from '../types'
import { DatabaseAdapter } from './adapter'
import { SQLiteAdapter } from './sqlite'

export function createDatabaseAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case 'sqlite':
      return new SQLiteAdapter(config.connection)
    case 'postgres':
      throw new Error('PostgreSQL adapter not yet implemented')
    case 'mysql':
      throw new Error('MySQL adapter not yet implemented')
    default:
      throw new Error(`Unknown database type: ${config.type}`)
  }
}
