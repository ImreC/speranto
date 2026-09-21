#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

async function findProjectRoot(startPath) {
  let currentPath = resolve(startPath)
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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectStart =
  process.env.SPERANTO_PROJECT_ROOT ??
  process.env.INIT_CWD ??
  process.env.npm_config_local_prefix

if (projectStart) {
  try {
    const projectRoot = await findProjectRoot(projectStart)
    if (projectRoot && projectRoot !== packageRoot) {
      const projectManifest = JSON.parse(
        await readFile(join(projectRoot, 'package.json'), 'utf-8'),
      )
      const dependencyGroups = [
        projectManifest.dependencies,
        projectManifest.devDependencies,
        projectManifest.optionalDependencies,
      ]
      if (
        dependencyGroups.some(
          (dependencies) => dependencies && '@speranto/speranto' in dependencies,
        )
      ) {
        const { manageAgentDocs } = await import('../dist/agent-docs.mjs')
        const result = await manageAgentDocs({ projectRoot, postinstall: true })
        for (const warning of result.warnings) {
          process.stderr.write(`[speranto] ${warning}\n`)
        }
        if (result.changedFiles.length > 0) {
          process.stdout.write('[speranto] Agent documentation is up to date.\n')
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[speranto] Could not update agent documentation: ${message}\n`)
  }
}
