#!/usr/bin/env bun
import { Command, InvalidArgumentError } from 'commander'
import { orchestrate } from './src/orchestrate'
import { TerminalProgressReporter } from './src/progress/terminal'
import { loadConfig } from './src/util/config'
import pkg from './package.json' with { type: 'json' }
import type { Config } from './src/types'

export type { Config, FileConfig, DatabaseConfig, TableConfig } from './src/config'

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
  .option('-b, --base-url <url>', 'Base URL for OpenAI-compatible API')
  .option('-i, --instructions-dir <path>', 'Directory containing language instruction files')
  .option(
    '-n, --concurrency <number>',
    'Max concurrent LLM calls across all languages and sources (default 5, local default 1)',
    parseConcurrency,
  )
  .option('-v, --verbose', 'Enable verbose output for debugging')
  .option('-r, --retranslate', 'Force retranslation of all values, even if already translated')
  .option('--init', 'Build state from existing translations without translating')
  .action(async (options) => {
    const passedConfig = await loadConfig(options.config)

    const config: Config = {
      model: options.model || passedConfig.model || 'mistral-large-latest',
      sourceLang: options.sourceLang || passedConfig.sourceLang || 'en',
      targetLangs: options.targetLangs || passedConfig.targetLangs || ['es'],
      provider: options.provider || passedConfig.provider || 'mistral',
      apiKey: options.apiKey || passedConfig.apiKey,
      baseUrl: options.baseUrl || passedConfig.baseUrl,
      concurrency: options.concurrency ?? passedConfig.concurrency,
      timeout: passedConfig.timeout,
      verbose: options.verbose || passedConfig.verbose || false,
      instructionsDir: options.instructionsDir || passedConfig.instructionsDir,
      files: passedConfig.files,
      database: passedConfig.database,
      retranslate: options.retranslate || passedConfig.retranslate || false,
      init: options.init || passedConfig.init || false,
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
        concurrency: config.concurrency,
        timeout: config.timeout,
        instructionsDir: config.instructionsDir,
        files: config.files,
        database: config.database
          ? { ...config.database, connection: '[redacted]' }
          : undefined,
        retranslate: config.retranslate,
        init: config.init,
      }
      console.log(`Resolved configuration:\n${JSON.stringify(verboseConfig, null, 2)}`)
    }

    console.log(`Speranto v${pkg.version}`)
    console.log(
      `Translating from ${config.sourceLang} to ${config.targetLangs.join(', ')} using ${config.model}`,
    )

    try {
      await orchestrate(config, pkg.version, new TerminalProgressReporter())
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`)
      process.exit(1)
    }
  })

program.parse()
