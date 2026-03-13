import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'path'

export interface StoredFileGroupState {
  rowHash: string
  fieldHashes: Record<string, string>
  translations: Record<string, string>
}

export interface StoredMarkdownChunkState {
  rowHash: string
  translatedText: string
}

export interface StoredFileState {
  fileHash: string
  format: 'json' | 'js' | 'md'
  groups?: Record<string, StoredFileGroupState>
  chunks?: Record<string, StoredMarkdownChunkState>
}

interface FileStateData {
  version: 1
  files: Record<string, StoredFileState>
}

export class FileStateStore {
  private data: FileStateData = {
    version: 1,
    files: {},
  }
  private dirty = false
  private path: string

  constructor(rootDir: string, targetLang: string) {
    this.path = join(rootDir, 'files', `${targetLang}.json`)
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) {
      return
    }

    try {
      const content = await readFile(this.path, 'utf-8')
      const parsed = JSON.parse(content) as FileStateData
      if (parsed && parsed.version === 1 && parsed.files) {
        this.data = parsed
      }
    } catch {
      this.data = {
        version: 1,
        files: {},
      }
    }
  }

  get(relativePath: string): StoredFileState | undefined {
    return this.data.files[relativePath]
  }

  set(relativePath: string, state: StoredFileState): void {
    this.data.files[relativePath] = state
    this.dirty = true
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return
    }

    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf-8')
    this.dirty = false
  }
}
