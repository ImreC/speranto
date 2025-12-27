#!/usr/bin/env bun
import { Command } from 'commander'
import { translate } from './src/translate'
import type { Config } from './src/types'
import { loadConfig } from './src/util/config'
import pkg from './package.json' assert { type: 'json' }

export type { Config, FileConfig, DatabaseConfig, TableConfig } from './src/config'

const program = new Command()

program
  .name('speranto')
  .description('A quick and simple machine translation tool for i18n in webapps')
  .version(pkg.version)
  .option(
    '-c, --config <path>',
    'Path to config file. Looks for speranto.config.ts or speranto.config.js in the current working directory if not specified',
  )
  .option('-m, --model <model>', 'Model to use for translation')
  .option('-t, --temperature <number>', 'Temperature for translation', parseFloat)
  .option('-s, --source-lang <lang>', 'Source language code')
  .option('-l, --target-langs <langs>', 'Target language codes (comma-separated)', (value) =>
    value.split(','),
  )
  .option('-p, --provider <provider>', 'LLM provider (openai, ollama, mistral)')
  .option('-k, --api-key <key>', 'API key for LLM provider')
  .option('-i, --instructions-dir <path>', 'Directory containing language instruction files')
  .option('-v, --verbose', 'Enable verbose output for debugging')
  .option('-r, --retranslate', 'Force retranslation of all values, even if already translated')
  .action(async (options) => {
    const passedConfig = await loadConfig(options.config)

    const config: Config = {
      model: options.model || passedConfig.model || 'mistral-large-latest',
      temperature: options.temperature ?? passedConfig.temperature ?? 0.0,
      sourceLang: options.sourceLang || passedConfig.sourceLang || 'en',
      targetLangs: options.targetLangs || passedConfig.targetLangs || ['es'],
      provider: (options.provider || passedConfig.provider || 'mistral') as
        | 'openai'
        | 'ollama'
        | 'mistral',
      apiKey: options.apiKey || passedConfig.apiKey,
      verbose: options.verbose || passedConfig.verbose || false,
      instructionsDir: options.instructionsDir || passedConfig.instructionsDir,
      files: passedConfig.files,
      database: passedConfig.database,
      retranslate: options.retranslate || passedConfig.retranslate || false,
    }

    if (!config.files && !config.database) {
      console.error('Error: No translation sources configured.')
      console.error('Add "files" or "database" to your config file.')
      process.exit(1)
    }

    console.log(`Speranto v${pkg.version}`)
    console.log(
      `Starting translation from ${config.sourceLang} to ${config.targetLangs.join(
        ', ',
      )} using model ${config.model}`,
    )

    if (config.files) {
      console.log(`Files: ${config.files.sourceDir} -> ${config.files.targetDir}`)
    }
    if (config.database) {
      console.log(
        `Database: ${config.database.type} (${config.database.tables.length} tables)`,
      )
    }

    try {
      await translate(config)
    } catch (error) {
      console.error('Error during translation:', error)
      process.exit(1)
    }
  })

program.parse()
