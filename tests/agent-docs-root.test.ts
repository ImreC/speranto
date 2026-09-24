import { afterEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentDocsRoots } from '../scripts/agent-docs-root.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function createPackage(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify({ name }))
}

async function createSperantoConsumer(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({
      name,
      dependencies: { '@speranto/speranto': '^0.4.0' },
    }),
  )
}

async function createWorkspacePackage(
  path: string,
  workspaces: string[] | { packages: string[] },
): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name: 'consumer-workspace', workspaces }),
  )
}

test(
  'uses the pnpm workspace root for a dependency installed in a nested package',
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'speranto-workspace-'))
    temporaryDirectories.push(workspaceRoot)
    const dependencyRoot = join(workspaceRoot, 'apps', 'frontend')
    await createPackage(workspaceRoot, 'consumer-workspace')
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
    await createPackage(dependencyRoot, 'frontend')

    await expect(resolveAgentDocsRoots(dependencyRoot)).resolves.toEqual({
      dependencyRoot,
      projectRoot: workspaceRoot,
    })
  },
)

test(
  'finds a nested pnpm workspace dependency when installation starts at the root',
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'speranto-workspace-'))
    temporaryDirectories.push(workspaceRoot)
    const dependencyRoot = join(workspaceRoot, 'apps', 'frontend')
    await createPackage(workspaceRoot, 'consumer-workspace')
    await writeFile(
      join(workspaceRoot, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n",
    )
    await createSperantoConsumer(dependencyRoot, 'frontend')

    await expect(resolveAgentDocsRoots(workspaceRoot)).resolves.toEqual({
      dependencyRoot,
      projectRoot: workspaceRoot,
    })
  },
)

test('keeps the workspace root when it directly depends on Speranto', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'speranto-workspace-'))
  temporaryDirectories.push(workspaceRoot)
  const nestedRoot = join(workspaceRoot, 'apps', 'frontend')
  await createSperantoConsumer(workspaceRoot, 'consumer-workspace')
  await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  await createSperantoConsumer(nestedRoot, 'frontend')

  await expect(resolveAgentDocsRoots(workspaceRoot)).resolves.toEqual({
    dependencyRoot: workspaceRoot,
    projectRoot: workspaceRoot,
  })
})

test.each([
  { name: 'array', workspaces: ['apps/*'] },
  { name: 'object', workspaces: { packages: ['apps/*'] } },
])(
  'finds a nested dependency from package.json workspaces with the $name form',
  async ({ workspaces }) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'speranto-workspace-'))
    temporaryDirectories.push(workspaceRoot)
    const dependencyRoot = join(workspaceRoot, 'apps', 'frontend')
    await createWorkspacePackage(workspaceRoot, workspaces)
    await createSperantoConsumer(dependencyRoot, 'frontend')

    await expect(resolveAgentDocsRoots(workspaceRoot)).resolves.toEqual({
      dependencyRoot,
      projectRoot: workspaceRoot,
    })
  },
)

test('uses the dependency package when it is not in a workspace', async () => {
  const parentRoot = await mkdtemp(join(tmpdir(), 'speranto-project-'))
  temporaryDirectories.push(parentRoot)
  const dependencyRoot = join(parentRoot, 'frontend')
  await createPackage(parentRoot, 'parent-project')
  await createPackage(dependencyRoot, 'frontend')

  await expect(resolveAgentDocsRoots(dependencyRoot)).resolves.toEqual({
    dependencyRoot,
    projectRoot: dependencyRoot,
  })
})

test.each([
  { name: 'array', workspaces: ['apps/*'] },
  { name: 'object', workspaces: { packages: ['apps/*'] } },
])('uses a package.json workspace root with the $name form', async ({ workspaces }) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'speranto-workspace-'))
  temporaryDirectories.push(workspaceRoot)
  const dependencyRoot = join(workspaceRoot, 'apps', 'frontend')
  await createWorkspacePackage(workspaceRoot, workspaces)
  await createPackage(dependencyRoot, 'frontend')

  await expect(resolveAgentDocsRoots(dependencyRoot)).resolves.toEqual({
    dependencyRoot,
    projectRoot: workspaceRoot,
  })
})

test('an explicit project root overrides pnpm workspace discovery', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'speranto-workspace-'))
  temporaryDirectories.push(workspaceRoot)
  const dependencyRoot = join(workspaceRoot, 'apps', 'frontend')
  const projectRoot = join(workspaceRoot, 'docs-target')
  await createPackage(workspaceRoot, 'consumer-workspace')
  await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  await createPackage(dependencyRoot, 'frontend')
  await createPackage(projectRoot, 'docs-target')

  await expect(resolveAgentDocsRoots(dependencyRoot, projectRoot)).resolves.toEqual({
    dependencyRoot,
    projectRoot,
  })
})
