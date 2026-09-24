#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAgentDocsRoots } from './agent-docs-root.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencyStart =
  process.env.INIT_CWD ??
  process.env.npm_config_local_prefix ??
  process.env.SPERANTO_PROJECT_ROOT

if (dependencyStart) {
  try {
    const roots = await resolveAgentDocsRoots(
      dependencyStart,
      process.env.SPERANTO_PROJECT_ROOT,
    )
    if (roots && roots.dependencyRoot !== packageRoot) {
      const { manageAgentDocs } = await import('../dist/agent-docs.mjs')
      const installResult = await manageAgentDocs({
        projectRoot: roots.projectRoot,
        dependencyRoot: roots.dependencyRoot,
        postinstall: true,
      })
      const warnings = [...installResult.warnings]
      let changed = installResult.changedFiles.length > 0

      if (
        installResult.status !== 'skipped' &&
        installResult.warnings.length === 0 &&
        roots.projectRoot !== roots.dependencyRoot
      ) {
        const removalResult = await manageAgentDocs({
          mode: 'remove',
          projectRoot: roots.dependencyRoot,
        })
        warnings.push(...removalResult.warnings)
        changed ||= removalResult.changedFiles.length > 0
      }

      for (const warning of warnings) {
        process.stderr.write(`[speranto] ${warning}\n`)
      }
      if (changed) {
        process.stdout.write('[speranto] Agent documentation is up to date.\n')
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[speranto] Could not update agent documentation: ${message}\n`)
  }
}
