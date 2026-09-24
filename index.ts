#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { Command, InvalidArgumentError } from 'commander'
import { manageAgentDocs } from './src/agent-docs'
import { cleanupDatabase, type DatabaseCleanupPlan } from './src/database-cleanup'
import { orchestrate } from './src/orchestrate'
import { TerminalProgressReporter } from './src/progress/terminal'
import { loadConfig } from './src/util/config'
import pkg from './package.json' with { type: 'json' }
import type { Config } from './src/types'

export type {
  Config,
  FileConfig,
  DatabaseConfig,
  TableConfig,
  OllamaConfig,
} from './src/config'

const program = new Command()

function parseConcurrency(value: string): number {
  const concurrency = Number(value)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidArgumentError('Concurrency must be a positive integer')
  }
  return concurrency
}

program
  .name('speranto')
  .description('A quick and simple machine translation tool for i18n in webapps')
  .version(pkg.version)

program
  .command('setup-agents')
  .description('Install or update Speranto documentation for coding agents')
  .option('--check', 'Check whether the installed agent documentation is current')
  .option('--remove', 'Remove Speranto-managed agent documentation and references')
  .option('--root <path>', 'Project root to update', process.cwd())
  .action(async (options: { check?: boolean; remove?: boolean; root: string }) => {
    if (options.check && options.remove) {
      process.stderr.write('Error: --check and --remove cannot be used together.\n')
      process.exitCode = 1
      return
    }

    try {
      const result = await manageAgentDocs({
        mode: options.remove ? 'remove' : options.check ? 'check' : 'install',
        projectRoot: options.root,
      })
      for (const warning of result.warnings) {
        process.stderr.write(`Warning: ${warning}\n`)
      }
      if (result.status === 'stale') {
        process.stderr.write(
          `Speranto agent documentation is stale: ${result.changedFiles.join(', ')}\n`,
        )
        process.exitCode = 1
        return
      }
      if (result.changedFiles.length === 0) {
        process.stdout.write('Speranto agent documentation is already current.\n')
        return
      }
      process.stdout.write(
        `Speranto agent documentation ${result.status}: ${result.changedFiles.join(', ')}\n`,
      )
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`)
      process.exitCode = 1
    }
  })

program
  .command('cleanup')
  .description('Remove stale database translation rows')
  .option('-c, --config <path>', 'Path to the Speranto config file')
  .option('-y, --yes', 'Approve deletion without prompting')
  .action(async (_options: { config?: string; yes?: boolean }, command: Command) => {
    const cleanupOptions = command.optsWithGlobals() as {
      config?: string
      yes?: boolean
    }
    const passedConfig = await loadConfig(cleanupOptions.config)
    if (!passedConfig.database) {
      process.stderr.write('Error: No database translation source configured.\n')
      process.exitCode = 1
      return
    }

    try {
      const result = await cleanupDatabase(
        {
          sourceLang: passedConfig.sourceLang || 'en',
          targetLangs: passedConfig.targetLangs || ['es'],
          database: passedConfig.database,
        },
        async (plan) =>
          confirmDatabaseCleanup(
            plan,
            cleanupOptions.yes ?? false,
            passedConfig.database.translationTableSuffix || '_translations',
          ),
      )

      if (result.total === 0) {
        process.stdout.write('No stale database translation rows found.\n')
      } else if (result.approved) {
        process.stdout.write(`Deleted ${result.total} stale database translation row(s).\n`)
      } else {
        process.stdout.write('Cleanup cancelled; no rows were deleted.\n')
      }
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`)
      process.exitCode = 1
    }
  })

async function confirmDatabaseCleanup(
  plan: DatabaseCleanupPlan,
  approvedWithoutPrompt: boolean,
  translationTableSuffix: string,
): Promise<boolean> {
  process.stdout.write(`Found ${plan.total} stale database translation row(s):\n`)
  for (const { table, translations } of plan.tables) {
    if (translations.length === 0) continue
    const tableName = table.schema
      ? `${table.schema}.${table.name}${translationTableSuffix}`
      : `${table.name}${translationTableSuffix}`
    process.stdout.write(`  ${tableName}: ${translations.length}\n`)
  }

  if (approvedWithoutPrompt) return true

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question('Delete these rows? [y/N] ')
    return /^(y|yes)$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

program
  .option(
    '-c, --config <path>',
    'Path to config file. Looks for speranto.config.ts or speranto.config.js in the current working directory if not specified',
  )
  .option('-m, --model <model>', 'Model to use for translation')
  .option('-s, --source-lang <lang>', 'Source language code')
  .option('-l, --target-langs <langs>', 'Target language codes (comma-separated)', (value) =>
    value.split(','),
  )
  .option(
    '-p, --provider <provider>',
    'LLM provider (openai, ollama, mistral, or any OpenAI-compatible)',
  )
  .option('-k, --api-key <key>', 'API key for LLM provider')
  .option('-b, --base-url <url>', 'Base URL for the LLM provider')
  .option('-i, --instructions-dir <path>', 'Directory containing language instruction files')
  .option(
    '-n, --concurrency <number>',
    'Max concurrent LLM calls across all languages and sources (default 5, local default 1)',
    parseConcurrency,
  )
  .option('-v, --verbose', 'Enable verbose output for debugging')
  .option('-r, --retranslate', 'Force retranslation of all values, even if already translated')
  .option('--init', 'Build state from existing translations without translating')
  .option(
    '--dry-run',
    'Report pending translation work without translating or writing changes',
  )
  .action(async (options) => {
    const passedConfig = await loadConfig(options.config)
    const provider = options.provider || passedConfig.provider || 'mistral'

    const config: Config = {
      model:
        options.model ||
        passedConfig.model ||
        (provider === 'ollama' ? 'gemma3:4b' : 'mistral-large-latest'),
      sourceLang: options.sourceLang || passedConfig.sourceLang || 'en',
      targetLangs: options.targetLangs || passedConfig.targetLangs || ['es'],
      provider,
      apiKey: options.apiKey || passedConfig.apiKey,
      baseUrl: options.baseUrl || passedConfig.baseUrl,
      ollama: passedConfig.ollama,
      concurrency: options.concurrency ?? passedConfig.concurrency,
      timeout: passedConfig.timeout,
      verbose: options.verbose || passedConfig.verbose || false,
      instructionsDir: options.instructionsDir || passedConfig.instructionsDir,
      files: passedConfig.files,
      database: passedConfig.database,
      retranslate: options.retranslate || passedConfig.retranslate || false,
      init: options.init || passedConfig.init || false,
      dryRun: options.dryRun || passedConfig.dryRun || false,
    }

    if (!config.files && !config.database) {
      process.stderr.write('Error: No translation sources configured.\n')
      process.stderr.write('Add "files" or "database" to your config file.\n')
      process.exit(1)
    }

    if (config.verbose) {
      const verboseConfig = {
        model: config.model,
        sourceLang: config.sourceLang,
        targetLangs: config.targetLangs,
        provider: config.provider,
        apiKey: config.apiKey ? '[set]' : undefined,
        baseUrl: config.baseUrl,
        ollama: config.ollama,
        concurrency: config.concurrency,
        timeout: config.timeout,
        instructionsDir: config.instructionsDir,
        files: config.files,
        database: config.database
          ? { ...config.database, connection: '[redacted]' }
          : undefined,
        retranslate: config.retranslate,
        init: config.init,
        dryRun: config.dryRun,
      }
      console.log(`Resolved configuration:\n${JSON.stringify(verboseConfig, null, 2)}`)
    }

    console.log(`Speranto v${pkg.version}`)
    console.log(`Provider: ${config.provider} · Model: ${config.model}`)

    try {
      await orchestrate(config, pkg.version, new TerminalProgressReporter())
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`)
      process.exit(1)
    }
  })

await program.parseAsync()
