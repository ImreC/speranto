import { DatabaseSync } from 'node:sqlite'

export class Database extends DatabaseSync {
  constructor(path: string, options: { readonly?: boolean } = {}) {
    super(path, { readOnly: options.readonly })
  }

  run(sql: string): void {
    this.exec(sql)
  }

  query(sql: string) {
    return this.prepare(sql)
  }
}
