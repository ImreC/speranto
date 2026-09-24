import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function findPackageRoot(startPath) {
  let currentPath = resolve(startPath)
  try {
    if (!(await lstat(currentPath)).isDirectory()) {
      currentPath = dirname(currentPath)
    }
  } catch {
    return undefined
  }

  while (true) {
    if (await pathExists(join(currentPath, 'package.json'))) {
      return currentPath
    }
    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      return undefined
    }
    currentPath = parentPath
  }
}

async function hasPackageWorkspaces(path) {
  if (!(await pathExists(path))) {
    return false
  }

  const manifest = JSON.parse(await readFile(path, 'utf-8'))
  const workspaces = manifest.workspaces
  return (
    Array.isArray(workspaces) ||
    (typeof workspaces === 'object' &&
      workspaces !== null &&
      Array.isArray(workspaces.packages))
  )
}

export async function findWorkspaceRoot(startPath) {
  let currentPath = resolve(startPath)

  while (true) {
    if (
      ((await pathExists(join(currentPath, 'pnpm-workspace.yaml'))) &&
        (await pathExists(join(currentPath, 'package.json')))) ||
      (await hasPackageWorkspaces(join(currentPath, 'package.json')))
    ) {
      return currentPath
    }
    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      return undefined
    }
    currentPath = parentPath
  }
}

export async function resolveAgentDocsRoots(dependencyStart, projectRootOverride) {
  const dependencyRoot = await findPackageRoot(dependencyStart)
  if (!dependencyRoot) {
    return undefined
  }

  const projectRoot = projectRootOverride
    ? await findPackageRoot(projectRootOverride)
    : ((await findWorkspaceRoot(dependencyRoot)) ?? dependencyRoot)

  if (!projectRoot) {
    return undefined
  }

  return { dependencyRoot, projectRoot }
}
