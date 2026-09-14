import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

    const childProcess = Bun.spawn(
      [process.execPath, join(import.meta.dir, '..', 'index.ts'), '--config', configPath],
      {
        cwd: testDir,
        env: { ...Bun.env, LLM_API_KEY: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const exitCode = await childProcess.exited
    const stdout = await new Response(childProcess.stdout).text()
    const stderr = await new Response(childProcess.stderr).text()

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('Resolved configuration')
    expect(stdout).toContain('"init": true')
    expect(await readFile(targetPath, 'utf-8')).toBe('{"title":"Hola"}')
    expect(await readFile(join(testDir, '.speranto', 'files', 'es.json'), 'utf-8')).toContain(
      'messages.json',
    )
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('CLI should reject invalid concurrency values', async () => {
  const childProcess = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'index.ts'), '--concurrency', '3invalid'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await childProcess.exited
  const stderr = await new Response(childProcess.stderr).text()

  expect(exitCode).toBe(1)
  expect(stderr).toContain('Concurrency must be a positive integer')
})
