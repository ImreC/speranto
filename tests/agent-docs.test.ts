import { afterEach, expect, test } from 'vitest'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manageAgentDocs } from '../src/agent-docs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function createProject(): Promise<{ projectRoot: string; sourceGuidePath: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'speranto-agent-docs-'))
  temporaryDirectories.push(projectRoot)
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'consumer-project',
      dependencies: { '@speranto/speranto': '^0.4.0' },
    }),
  )
  const sourceGuidePath = join(projectRoot, 'canonical-agent-guide.md')
  await writeFile(sourceGuidePath, '# Canonical Speranto guide\n')
  return { projectRoot, sourceGuidePath }
}

function countManagedBlocks(content: string): number {
  return content.match(/<!-- speranto-agent-docs:start -->/g)?.length ?? 0
}

test('installs the guide and creates AGENTS.md when no instruction file exists', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()

  const result = await manageAgentDocs({
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.0',
  })

  expect(result.status).toBe('installed')
  expect(await readFile(join(projectRoot, '.agents', 'speranto', 'guide.md'), 'utf-8')).toBe(
    '# Canonical Speranto guide\n',
  )
  const agentsContent = await readFile(join(projectRoot, 'AGENTS.md'), 'utf-8')
  expect(agentsContent).toContain('read and follow @.agents/speranto/guide.md')
  const manifest = JSON.parse(
    await readFile(join(projectRoot, '.agents', 'speranto', 'manifest.json'), 'utf-8'),
  )
  expect(manifest.packageVersion).toBe('0.4.0')
  expect(manifest.createdInstructionFiles).toEqual(['AGENTS.md'])
})

test('updates existing instruction files without duplicating managed blocks', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await writeFile(join(projectRoot, 'AGENTS.md'), '# Existing agent instructions\n')
  await writeFile(join(projectRoot, 'CLAUDE.md'), '# Existing Claude instructions\n')

  const firstResult = await manageAgentDocs({
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.0',
  })
  const secondResult = await manageAgentDocs({
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.0',
  })

  expect(firstResult.status).toBe('installed')
  expect(secondResult.status).toBe('current')
  const agentsContent = await readFile(join(projectRoot, 'AGENTS.md'), 'utf-8')
  const claudeContent = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8')
  expect(agentsContent.startsWith('# Existing agent instructions')).toBe(true)
  expect(claudeContent.startsWith('# Existing Claude instructions')).toBe(true)
  expect(countManagedBlocks(agentsContent)).toBe(1)
  expect(countManagedBlocks(claudeContent)).toBe(1)
})

test('does not update CLAUDE.md when it already imports AGENTS.md', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await writeFile(join(projectRoot, 'AGENTS.md'), '# Existing agent instructions\n')
  const originalClaudeContent = '# Claude instructions\n\n@AGENTS.md\n'
  await writeFile(join(projectRoot, 'CLAUDE.md'), originalClaudeContent)

  await manageAgentDocs({ projectRoot, sourceGuidePath, packageVersion: '0.4.0' })

  expect(await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe(originalClaudeContent)
  expect(await readFile(join(projectRoot, 'AGENTS.md'), 'utf-8')).toContain(
    '@.agents/speranto/guide.md',
  )
})

test('uses a correct relative import from .claude/CLAUDE.md', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await mkdir(join(projectRoot, '.claude'), { recursive: true })
  await writeFile(join(projectRoot, '.claude', 'CLAUDE.md'), '# Claude instructions\n')

  await manageAgentDocs({ projectRoot, sourceGuidePath, packageVersion: '0.4.0' })

  expect(await readFile(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8')).toContain(
    '@../.agents/speranto/guide.md',
  )
})

test('check reports stale content and install updates the guide', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await manageAgentDocs({ projectRoot, sourceGuidePath, packageVersion: '0.4.0' })
  await writeFile(sourceGuidePath, '# Updated canonical guide\n')

  const checkResult = await manageAgentDocs({
    mode: 'check',
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.1',
  })
  expect(checkResult.status).toBe('stale')
  expect(await readFile(join(projectRoot, '.agents', 'speranto', 'guide.md'), 'utf-8')).toBe(
    '# Canonical Speranto guide\n',
  )

  const updateResult = await manageAgentDocs({
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.1',
  })
  expect(updateResult.status).toBe('updated')
  expect(await readFile(join(projectRoot, '.agents', 'speranto', 'guide.md'), 'utf-8')).toBe(
    '# Updated canonical guide\n',
  )
})

test('remove deletes managed files and an AGENTS.md created by the installer', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await manageAgentDocs({ projectRoot, sourceGuidePath, packageVersion: '0.4.0' })

  const result = await manageAgentDocs({ mode: 'remove', projectRoot })

  expect(result.status).toBe('removed')
  await expect(access(join(projectRoot, 'AGENTS.md'))).rejects.toThrow()
  await expect(access(join(projectRoot, '.agents', 'speranto'))).rejects.toThrow()
})

test('remove preserves user-authored instruction content', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await writeFile(join(projectRoot, 'AGENTS.md'), '# User instructions\n')
  await manageAgentDocs({ projectRoot, sourceGuidePath, packageVersion: '0.4.0' })

  await manageAgentDocs({ mode: 'remove', projectRoot })

  expect(await readFile(join(projectRoot, 'AGENTS.md'), 'utf-8')).toBe(
    '# User instructions\n',
  )
})

test('does not overwrite an instruction file with malformed managed markers', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  const malformedContent = '# User instructions\n\n<!-- speranto-agent-docs:start -->\n'
  await writeFile(join(projectRoot, 'AGENTS.md'), malformedContent)

  const result = await manageAgentDocs({
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.0',
  })

  expect(result.warnings).toHaveLength(1)
  expect(await readFile(join(projectRoot, 'AGENTS.md'), 'utf-8')).toBe(malformedContent)
})

test('postinstall skips projects where Speranto is not a direct dependency', async () => {
  const { projectRoot, sourceGuidePath } = await createProject()
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'consumer-project' }),
  )

  const result = await manageAgentDocs({
    projectRoot,
    sourceGuidePath,
    packageVersion: '0.4.0',
    postinstall: true,
  })

  expect(result.status).toBe('skipped')
  await expect(access(join(projectRoot, '.agents', 'speranto', 'guide.md'))).rejects.toThrow()
})
