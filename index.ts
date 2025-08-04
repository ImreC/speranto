#!/usr/bin/env bun
import { Command } from 'commander'
import { resolve } from 'path'
import { translate } from './src/translate'
import type { Config } from './src/types'

const program = new Command()

const loadConfig = async (configPath: string) => {
  try {
    const configModule = await import(configPath)
    const config: Config = configModule.default

    console.log(
      `Starting translation from ${config.sourceLang} to ${config.targetLangs.join(
        ', ',
      )} usng model ${config.model}`,
    )
    console.log(config)

    return config
  } catch (error) {
    console.error('Error loading config:', error)
    process.exit(1)
  }
}
program
  .name('speranto')
  .description('A quick and simple machine translation tool for i18n in webapps')
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to config file', './speranto.config.ts')
  .option('-m, --model <model>', 'Model to use for translation', 'gpt-4o-mini')
  .option('-t, --temperature <number>', 'Temperature for translation', parseFloat, 0.0)
  .option('-s, --source-lang <lang>', 'Source language code', 'en')
  .option(
    '-l, --target-langs <langs>',
    'Target language codes (comma-separated)',
    (value) => value.split(','),
    ['es'],
  )
  .option('-i, --source-dir <dir>', 'Source directory path', './content')
  .option(
    '-o, --target-dir <dir>',
    'Target directory path (use [lang] as placeholder)',
    './content/[lang]',
  )
  .option('-p, --provider <provider>', 'LLM provider (openai, ollama, mistral)', 'openai')
  .option(
    '--use-lang-code-as-filename',
    'Use language code as filename instead of keeping original names',
    false,
  )
  .action(async (options) => {
    let passedConfig = {}
    if (options.config) {
      passedConfig = await loadConfig(options.config)
    }
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
      console.log(config)

      await translate(config)
    } catch (error) {
      console.error('Error during translation:', error)
      process.exit(1)
    }
  })

program.parse()
