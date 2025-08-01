#!/usr/bin/env bun
import { Command } from 'commander'
import { resolve } from 'path'
import { translate } from './src/translate'
import type { Config } from './src/types'

const program = new Command()

program
  .name('speranto')
  .description('A quick and simple machine translation tool for i18n in webapps')
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to config file', './speranto.config.ts')
  .action(async (options) => {
    const configPath = resolve(process.cwd(), options.config)

    try {
      const configModule = await import(configPath)
      const config: Config = configModule.default

      console.log(
        `Starting translation from ${config.sourceLang} to ${config.targetLangs.join(
          ', ',
        )} usng model ${config.model}`,
      )

      await translate(config)
    } catch (error) {
      console.error('Error loading config:', error)
      process.exit(1)
    }
  })

program.parse()
