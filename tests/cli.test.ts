import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

function runCLI(args: string[], cwd?: string): Promise<{
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
