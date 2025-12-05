#!/usr/bin/env bun
import { Command } from 'commander'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { translate } from './src/translate'
import { translateDatabase } from './src/translate-database'
import type { Config, DatabaseTranslationConfig } from './src/types'
import { loadConfig } from './src/util/config'
import pkg from './package.json' assert { type: 'json' }

const program = new Command()

program
  .name('speranto')
  .description('A quick and simple machine translation tool for i18n in webapps')
  .version(pkg.version)
  .option(
    '-c, --config <path>',
    'Path to config file. Looks for speranto.config.ts or speranto.config.js in the current working directory if not specified',
  )
  .option('-m, --model <model>', 'Model to use for translation', 'mistral-large-latest')
  .option('-t, --temperature <number>', 'Temperature for translation', parseFloat, 0.0)
  .option('-s, --source-lang <lang>', 'Source language code', 'en')
  .option(
    '-l, --target-langs <langs>',
    'Target language codes (comma-separated)',
    (value) => value.split(','),
    ['es'],
  )
  .option(
    '-i, --source-dir <dir>',
    'Source directory path. Will take all .json, .js, .ts and .md files in the root level of the folder.',
    './content',
  )
  .option(
    '-o, --target-dir <dir>',
    'Target directory path (use [lang] as placeholder)',
    './content/[lang]',
  )
  .option('-p, --provider <provider>', 'LLM provider (openai, ollama, mistral)', 'mistral')
  .option(
    '--use-lang-code-as-filename',
    'Use language code as filename instead of keeping original names',
    false,
  )
  .option('-k, --api-key <key>', 'API key for LLM provider')
  .option('--as-config', 'Write current options to config file and exit')
  .action(async (options) => {
    if (options.asConfig) {
      const configPath = options.config || 'speranto.config.ts'
      if (existsSync(configPath)) {
        console.warn(`Warning: ${configPath} already exists and will be overwritten.`)
        const readline = await import('node:readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await new Promise<string>((resolve) => {
          rl.question('Continue? [y/N] ', resolve)
        })
        rl.close()
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.')
          return
        }
      }
      const config: Record<string, unknown> = {
        model: options.model,
        temperature: options.temperature,
        sourceLang: options.sourceLang,
        targetLangs: options.targetLangs,
        sourceDir: options.sourceDir,
        targetDir: options.targetDir,
        provider: options.provider,
        useLangCodeAsFilename: options.useLangCodeAsFilename,
      }
      if (options.apiKey) {
        config.apiKey = options.apiKey
      }
      const configContent = `import type { Config } from 'speranto/src/types'

export default ${JSON.stringify(config, null, 2)} satisfies Partial<Config>
`
      await writeFile(configPath, configContent)
      console.log(`Config written to ${configPath}`)
      return
    }

    const passedConfig = await loadConfig(options.config)
    try {
      const config: Config = Object.assign(
        {
          model: options.model,
          temperature: options.temperature,
          sourceLang: options.sourceLang,
          targetLangs: options.targetLangs,
          sourceDir: resolve(process.cwd(), options.sourceDir),
          targetDir: resolve(process.cwd(), options.targetDir),
          provider: options.provider as 'openai' | 'ollama' | 'mistral',
          useLangCodeAsFilename: options.useLangCodeAsFilename,
          apiKey: options.apiKey,
        },
        passedConfig,
      )

      console.log(
        `Starting translation from ${config.sourceLang} to ${config.targetLangs.join(
          ', ',
        )} using model ${config.model}`,
      )
      console.log(
        'File naming strategy:',
        config.useLangCodeAsFilename ? 'use language codes' : 'keep original names',
      )

      await translate(config)
    } catch (error) {
      console.error('Error during translation:', error)
      process.exit(1)
    }
  })

program
  .command('db')
  .description('Translate content in database tables')
  .requiredOption('-c, --config <path>', 'Path to database config file')
  .option('-m, --model <model>', 'Model to use for translation')
  .option('-t, --temperature <number>', 'Temperature for translation', parseFloat)
  .option('-s, --source-lang <lang>', 'Source language code')
  .option(
    '-l, --target-langs <langs>',
    'Target language codes (comma-separated)',
    (value) => value.split(','),
  )
  .option('-p, --provider <provider>', 'LLM provider (openai, ollama, mistral)')
  .option('-k, --api-key <key>', 'API key for LLM provider')
  .action(async (options) => {
    const passedConfig = await loadConfig(options.config)

    if (!passedConfig.database) {
      console.error('Error: Database configuration is required. Please specify database config.')
      process.exit(1)
    }

    try {
      const config: DatabaseTranslationConfig = {
        model: options.model || passedConfig.model || 'mistral-large-latest',
        temperature: options.temperature ?? passedConfig.temperature ?? 0.0,
        sourceLang: options.sourceLang || passedConfig.sourceLang || 'en',
        targetLangs: options.targetLangs || passedConfig.targetLangs || ['es'],
        provider: (options.provider || passedConfig.provider || 'mistral') as
          | 'openai'
          | 'ollama'
          | 'mistral',
        apiKey: options.apiKey || passedConfig.apiKey,
        database: passedConfig.database,
      }

      console.log(
        `Starting database translation from ${config.sourceLang} to ${config.targetLangs.join(', ')} using model ${config.model}`,
      )
      console.log(`Database: ${config.database.type} - ${config.database.connection}`)
      console.log(`Tables: ${config.database.tables.map((t) => t.name).join(', ')}`)

      await translateDatabase(config)
    } catch (error) {
      console.error('Error during database translation:', error)
      process.exit(1)
    }
  })

program.parse()
