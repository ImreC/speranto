import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

function runCLI(args: string[], cwd?: string, input?: string): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  const childProcess = spawn(
    process.execPath,
    [
      '--import',
      require.resolve('tsx'),
      join(import.meta.dirname, '..', 'index.ts'),
      ...args,
    ],
    { cwd, env: { ...process.env, LLM_API_KEY: 'test' } },
  )
  let stdout = ''
  let stderr = ''
  childProcess.stdout.setEncoding('utf-8').on('data', (chunk) => (stdout += chunk))
  childProcess.stderr.setEncoding('utf-8').on('data', (chunk) => (stderr += chunk))
  childProcess.stdin.end(input)

  return new Promise((resolve, reject) => {
    childProcess.on('error', reject)
    childProcess.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
  })
}

test('CLI should honor init mode from the configuration file', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'speranto-cli-'))
  const sourceDir = join(testDir, 'source')
  const targetDir = join(testDir, 'target')
  const targetPath = join(targetDir, 'es', 'messages.json')

  try {
    await mkdir(sourceDir, { recursive: true })
    await mkdir(join(targetDir, 'es'), { recursive: true })
    await writeFile(join(sourceDir, 'messages.json'), '{"title":"Hello"}')
    await writeFile(targetPath, '{"title":"Hola"}')

    const configPath = join(testDir, 'speranto.config.ts')
    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        model: 'test-model',
        sourceLang: 'en',
        targetLangs: ['es'],
        provider: 'ollama',
        init: true,
        verbose: true,
        files: {
          sourceDir,
          targetDir: join(targetDir, '[lang]'),
        },
      })}`,
    )

    const { exitCode, stdout, stderr } = await runCLI(['--config', configPath], testDir)

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('Resolved configuration')
    expect(stdout).toContain('"init": true')
    expect(stdout.match(/^Speranto v/mg)).toHaveLength(1)
    expect(stdout).toContain('Provider: ollama · Model: test-model')
    expect(stdout).not.toContain('Translating from')
    expect(await readFile(targetPath, 'utf-8')).toBe('{"title":"Hola"}')
    expect(await readFile(join(testDir, '.speranto', 'files', 'es.json'), 'utf-8')).toContain(
      'messages.json',
    )
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('CLI should reject invalid concurrency values', async () => {
  const { exitCode, stderr } = await runCLI(['--concurrency', '3invalid'])

  expect(exitCode).toBe(1)
  expect(stderr).toContain('Concurrency must be a positive integer')
})

test('cleanup requires confirmation before deleting stale database translations', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'speranto-cleanup-'))
  const dbPath = join(testDir, 'content.db')
  const configPath = join(testDir, 'speranto.config.ts')

  try {
    const { Database } = await import('./mocks/Database')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT)`)
    db.run(`INSERT INTO articles (id, title) VALUES (1, 'Hello')`)
    db.run(`
      CREATE TABLE articles_translations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        lang TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        row_source_hash TEXT NOT NULL,
        field_source_hashes TEXT NOT NULL,
        title TEXT,
        UNIQUE(source_id, lang)
      )
    `)
    db.run(`
      INSERT INTO articles_translations
        (source_id, lang, source_lang, row_source_hash, field_source_hashes, title)
      VALUES
        ('1', 'en', 'en', 'hash', '{}', 'Hello'),
        ('1', 'es', 'en', 'hash', '{}', 'Hola'),
        ('1', 'fr', 'fr', 'old-hash', '{}', 'Bonjour'),
        ('2', 'es', 'en', 'orphan-hash', '{}', 'Huérfano')
    `)
    db.close()

    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        model: 'test-model',
        sourceLang: 'en',
        targetLangs: ['es'],
        provider: 'ollama',
        database: {
          type: 'sqlite',
          connection: dbPath,
          tables: [{ name: 'articles', columns: ['title'] }],
        },
      })}`,
    )

    const cancelled = await runCLI(['cleanup', '--config', configPath], testDir, 'n\n')
    expect(cancelled.exitCode, cancelled.stderr).toBe(0)
    expect(cancelled.stdout).toContain('Found 2 stale database translation row(s)')
    expect(cancelled.stdout).toContain('Cleanup cancelled; no rows were deleted.')

    let readDb = new Database(dbPath, { readonly: true })
    expect(readDb.query('SELECT id FROM articles_translations').all()).toHaveLength(4)
    readDb.close()

    const approved = await runCLI(['cleanup', '--config', configPath], testDir, 'y\n')
    expect(approved.exitCode, approved.stderr).toBe(0)
    expect(approved.stdout).toContain('Deleted 2 stale database translation row(s).')

    readDb = new Database(dbPath, { readonly: true })
    const rows = readDb
      .query('SELECT source_id, lang FROM articles_translations ORDER BY source_id, lang')
      .all()
    readDb.close()
    expect(rows).toEqual([
      { source_id: '1', lang: 'en' },
      { source_id: '1', lang: 'es' },
    ])
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})
