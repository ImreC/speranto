import { createHash } from 'node:crypto'

export interface HashEntry {
  key: string
  value: string
}

export interface HashMetadata {
  rowHash: string
  fieldHashes: Record<string, string>
}

export function createContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function createFieldHashes(entries: HashEntry[]): Record<string, string> {
  return Object.fromEntries(
    [...entries]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, value }) => [key, createContentHash(value)]),
  )
}

export function createHashMetadata(entries: HashEntry[], sourceLang: string): HashMetadata {
  const normalizedEntries = [...entries].sort((a, b) => a.key.localeCompare(b.key))
  const fieldHashes = createFieldHashes(normalizedEntries)

  return {
    rowHash: createContentHash(
      JSON.stringify({
        sourceLang,
        entries: normalizedEntries,
      }),
    ),
    fieldHashes,
  }
}
