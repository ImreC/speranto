import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { glob } from 'glob'

const packageName = '@speranto/speranto'

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

function getPackageWorkspacePatterns(manifest) {
  const workspaces = manifest.workspaces
  if (Array.isArray(workspaces)) {
    return workspaces
  }
  if (
    typeof workspaces === 'object' &&
    workspaces !== null &&
    Array.isArray(workspaces.packages)
  ) {
    return workspaces.packages
  }
  return []
}

function getPnpmWorkspacePatterns(content) {
  const patterns = []
  let packagesIndent

  for (const line of content.split('\n')) {
    const packagesMatch = line.match(/^(\s*)packages:\s*(?:#.*)?$/)
    if (packagesMatch) {
      packagesIndent = packagesMatch[1].length
      continue
    }
    if (packagesIndent === undefined || /^\s*(?:#.*)?$/.test(line)) {
      continue
    }

    const indentation = line.match(/^\s*/)?.[0].length ?? 0
    if (indentation <= packagesIndent) {
      break
    }

    const patternMatch = line.match(/^\s*-\s*(.*?)\s*(?:#.*)?$/)
    if (patternMatch) {
      patterns.push(patternMatch[1].replace(/^(['"])(.*)\1$/, '$2'))
    }
  }

  return patterns
}

async function getWorkspacePatterns(workspaceRoot) {
  const manifest = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf-8'))
  const packagePatterns = getPackageWorkspacePatterns(manifest)
  if (packagePatterns.length > 0) {
    return packagePatterns
  }

  const workspacePath = join(workspaceRoot, 'pnpm-workspace.yaml')
  if (!(await pathExists(workspacePath))) {
    return []
  }
  return getPnpmWorkspacePatterns(await readFile(workspacePath, 'utf-8'))
}

function hasDirectDependency(manifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
  ].some((dependencies) => dependencies && packageName in dependencies)
}

async function findWorkspaceDependencyRoot(workspaceRoot) {
  const patterns = await getWorkspacePatterns(workspaceRoot)
  const packagePatterns = patterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map((pattern) => `${pattern.replace(/\/$/, '')}/package.json`)
  if (packagePatterns.length === 0) {
    return undefined
  }

  const ignoredPatterns = [
    '**/node_modules/**',
    ...patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => `${pattern.slice(1).replace(/\/$/, '')}/**`),
  ]
  const manifestPaths = await glob(packagePatterns, {
    cwd: workspaceRoot,
    absolute: true,
    ignore: ignoredPatterns,
  })

  for (const manifestPath of manifestPaths.sort()) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    if (hasDirectDependency(manifest)) {
      return dirname(manifestPath)
    }
  }

  return undefined
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
  let dependencyRoot = await findPackageRoot(dependencyStart)
  if (!dependencyRoot) {
    return undefined
  }

  const projectRoot = projectRootOverride
    ? await findPackageRoot(projectRootOverride)
    : ((await findWorkspaceRoot(dependencyRoot)) ?? dependencyRoot)

  if (!projectRoot) {
    return undefined
  }

  const dependencyManifest = JSON.parse(
    await readFile(join(dependencyRoot, 'package.json'), 'utf-8'),
  )
  if (dependencyRoot === projectRoot && !hasDirectDependency(dependencyManifest)) {
    dependencyRoot = (await findWorkspaceDependencyRoot(projectRoot)) ?? dependencyRoot
  }

  return { dependencyRoot, projectRoot }
}
