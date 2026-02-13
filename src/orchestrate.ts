import { glob } from 'glob'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative, extname } from 'path'
import { getTranslatableChunks, parseMarkdown, stringifyMarkdown } from './parsers/md'
import {
  parseJSON,
  stringifyJSON,
  extractTranslatableGroups,
  reconstructJSON,
  splitLargeGroups,
  type TranslatableGroup,
  type SplitGroup,
} from './parsers/json'
import {
  parseJS,
  extractTranslatableGroupsJS,
  reconstructJS,
  splitLargeGroupsJS,
  type TranslatableJSGroup,
  type SplitJSGroup,
} from './parsers/js'
import { Translator } from './translator'
import { ConcurrencyQueue } from './concurrency'
import { ProgressReporter } from './progress'
import { detectChanges } from './change-detection'
import { orchestrateDatabase } from './orchestrate-database'
import type { Config, FileConfig } from './types'
import type { Root, BlockContent } from 'mdast'

interface FileTranslateConfig extends Config {
  files: FileConfig
}

export async function orchestrate(config: Config, version: string) {
  const reporter = new ProgressReporter(version)
  const concurrency = config.concurrency ?? 5
  const queue = new ConcurrencyQueue(concurrency)

  if (config.files) {
    await orchestrateFiles(config as FileTranslateConfig, queue, reporter)
  }

  if (config.database) {
    await orchestrateDatabase(config, queue, reporter)
  }
}

async function orchestrateFiles(
  config: FileTranslateConfig,
  queue: ConcurrencyQueue,
  reporter: ProgressReporter,
) {
  const { files } = config
  const extensions = ['md', 'json', 'js', 'ts']

  const patterns = extensions.map((ext) =>
    files.useLangCodeAsFilename
      ? join(files.sourceDir, `**/${config.sourceLang}.${ext}`)
      : join(files.sourceDir, `**/*.${ext}`),
  )

  const allFiles = (await Promise.all(patterns.map((pattern) => glob(pattern)))).flat()

  if (allFiles.length === 0) return

  reporter.header(config.sourceLang, config.targetLangs, allFiles.length)

  for (const targetLang of config.targetLangs) {
    const translator = new Translator({
      model: config.model,
      temperature: config.temperature,
      sourceLang: config.sourceLang,
      targetLang,
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      llm: config.llm,
      instructionsDir: config.instructionsDir,
      retranslate: config.retranslate,
    })

    const workItems = await collectFileWorkItems(allFiles, config, targetLang)

    if (workItems.length === 0) {
      reporter.skipLanguage(targetLang, 'nothing changed')
      continue
    }

    reporter.startLanguage(targetLang, workItems.length)

    const results: Array<{ filePath: string; write: () => Promise<void> }> = []
    const errors: Array<{ group: string; error: Error }> = []

    await Promise.all(
      workItems.map((item) =>
        queue.run(async () => {
          try {
            const result = await item.execute(translator)
            results.push(result)
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            errors.push({ group: item.label, error })
            reporter.reportError(targetLang, item.label, error.message)
          }
          reporter.updateProgress()
        }),
      ),
    )

    if (errors.length === 0) {
      const writesByFile = new Map<string, Array<() => Promise<void>>>()
      for (const result of results) {
        if (!writesByFile.has(result.filePath)) {
          writesByFile.set(result.filePath, [])
        }
        writesByFile.get(result.filePath)!.push(result.write)
      }
      for (const writers of writesByFile.values()) {
        for (const write of writers) {
          await write()
        }
      }
    }

    reporter.finishLanguage()
  }

  reporter.finish()
}

interface WorkItem {
  label: string
  execute: (translator: Translator) => Promise<{ filePath: string; write: () => Promise<void> }>
}

async function collectFileWorkItems(
  allFiles: string[],
  config: FileTranslateConfig,
  targetLang: string,
): Promise<WorkItem[]> {
  const workItems: WorkItem[] = []

  for (const filePath of allFiles) {
    const ext = extname(filePath)

    if (ext === '.md') {
      const items = await collectMarkdownWorkItems(filePath, config, targetLang)
      workItems.push(...items)
    } else if (ext === '.json') {
      const items = await collectJSONWorkItems(filePath, config, targetLang)
      workItems.push(...items)
    } else if (ext === '.js' || ext === '.ts') {
      const items = await collectJSWorkItems(filePath, config, targetLang, ext === '.ts')
      workItems.push(...items)
    }
  }

  return workItems
}

function getTargetPath(config: FileTranslateConfig, filePath: string, targetLang: string): string {
  const { files } = config
  const relativePath = relative(files.sourceDir, filePath)
  if (files.useLangCodeAsFilename) {
    const ext = extname(filePath)
    const dirPath = dirname(relativePath)
    return join(files.targetDir.replace('[lang]', targetLang), dirPath, `${targetLang}${ext}`)
  }
  return join(files.targetDir.replace('[lang]', targetLang), relativePath)
}

async function writeOutput(
  config: FileTranslateConfig,
  filePath: string,
  content: string,
  targetLang: string,
) {
  const targetPath = getTargetPath(config, filePath, targetLang)
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, content, 'utf-8')
}

async function collectMarkdownWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
): Promise<WorkItem[]> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  if (chunks.length === 0) return []

  return chunks.map((chunk, i) => ({
    label: `${relativePath} chunk ${i + 1}/${chunks.length}`,
    execute: async (translator: Translator) => {
      const translatedText = await translator.translateChunk(chunk)
      return {
        filePath,
        write: async () => {
          const freshContent = await readFile(filePath, 'utf-8')
          const freshTree = await parseMarkdown(freshContent)
          const translatedTree: Root = JSON.parse(JSON.stringify(freshTree))
          const translatedNodes = await parseMarkdown(translatedText)

          let nodeIndex = 0
          for (
            let j = chunk.startIndex;
            j <= chunk.endIndex && j < translatedTree.children.length;
            j++
          ) {
            if (nodeIndex < translatedNodes.children.length) {
              translatedTree.children[j] = translatedNodes.children[nodeIndex] as BlockContent
              nodeIndex++
            }
          }

          let translatedContent = await stringifyMarkdown(translatedTree)
          translatedContent += `\n\n_Translated automatically with ${config.model}. The original content was written in ${config.sourceLang}. Please allow for minor errors._`
          await writeOutput(config, filePath, translatedContent, targetLang)
        },
      }
    },
  }))
}

async function collectJSONWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
): Promise<WorkItem[]> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const jsonData = await parseJSON(content)
  const groups = await extractTranslatableGroups(jsonData)

  const splitGroups: SplitGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroups(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])

  const targetPath = getTargetPath(config, filePath, targetLang)
  const existingTranslations = new Map<string, string>()

  if (existsSync(targetPath) && !config.retranslate) {
    try {
      const existingContent = await readFile(targetPath, 'utf-8')
      const existingJSON = await parseJSON(existingContent)
      const rawExistingGroups = await extractTranslatableGroups(existingJSON)

      const splitExistingGroups: SplitGroup[] = config.files.maxStringsPerGroup
        ? splitLargeGroups(rawExistingGroups, config.files.maxStringsPerGroup)
        : rawExistingGroups.map((group) => ({ group }))
      const existingGroups = splitExistingGroups.flatMap((sg) => sg.subgroups || [sg.group])

      for (const group of existingGroups) {
        for (const str of group.strings) {
          existingTranslations.set(str.path.join('.'), str.value)
        }
      }
    } catch {
      // Could not parse existing, will retranslate all
    }
  }

  const workItems: WorkItem[] = []
  const allTranslatedStrings: Array<{ path: string[]; value: string }> = []
  let hasWorkItems = false

  for (const group of allGroups) {
    const sourceStrings = group.strings.map((str) => ({
      key: str.path.join('.'),
      value: str.value,
    }))

    const { changed, context } = detectChanges(sourceStrings, existingTranslations)

    if (changed.length === 0) {
      // All strings unchanged — use existing translations
      for (const str of group.strings) {
        allTranslatedStrings.push({
          path: str.path,
          value: existingTranslations.get(str.path.join('.')) ?? str.value,
        })
      }
      continue
    }

    hasWorkItems = true
    workItems.push({
      label: `${relativePath} "${group.groupKey}"`,
      execute: async (translator: Translator) => {
        const translatedChanged = await translator.translateGroupWithContext(
          group.groupKey,
          changed,
          context,
        )

        // Combine translated changed strings with context strings
        const translatedMap = new Map(translatedChanged.map((s) => [s.key, s.value]))
        const contextMap = new Map(context.map((s) => [s.key, s.value]))

        for (const str of group.strings) {
          const key = str.path.join('.')
          const translatedValue =
            translatedMap.get(key) ?? contextMap.get(key) ?? str.value
          allTranslatedStrings.push({ path: str.path, value: translatedValue })
        }

        return {
          filePath,
          write: async () => {
            const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
            const translatedContent = await stringifyJSON(translatedJSON)
            await writeOutput(config, filePath, translatedContent, targetLang)
          },
        }
      },
    })
  }

  if (!hasWorkItems && allTranslatedStrings.length > 0) {
    // All groups unchanged but we have existing translations - no work needed
    return []
  }

  return workItems
}

async function collectJSWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  isTypeScript: boolean,
): Promise<WorkItem[]> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const ast = await parseJS(content, isTypeScript)
  const groups = await extractTranslatableGroupsJS(ast)

  const splitGroups: SplitJSGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroupsJS(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])

  const targetPath = getTargetPath(config, filePath, targetLang)
  const existingTranslations = new Map<string, string>()

  if (existsSync(targetPath) && !config.retranslate) {
    try {
      const existingContent = await readFile(targetPath, 'utf-8')
      const existingAST = await parseJS(existingContent, isTypeScript)
      const rawExistingGroups = await extractTranslatableGroupsJS(existingAST)

      const splitExistingGroups: SplitJSGroup[] = config.files.maxStringsPerGroup
        ? splitLargeGroupsJS(rawExistingGroups, config.files.maxStringsPerGroup)
        : rawExistingGroups.map((group) => ({ group }))
      const existingGroups = splitExistingGroups.flatMap((sg) => sg.subgroups || [sg.group])

      for (const group of existingGroups) {
        for (const str of group.strings) {
          existingTranslations.set(str.objectPath.join('.') || str.path, str.value)
        }
      }
    } catch {
      // Could not parse existing, will retranslate all
    }
  }

  const workItems: WorkItem[] = []
  const allTranslatedStrings: Array<{ path: string; value: string }> = []
  let hasWorkItems = false

  for (const group of allGroups) {
    const sourceStrings = group.strings.map((str) => ({
      key: str.objectPath.join('.') || str.path,
      value: str.value,
    }))

    const { changed, context } = detectChanges(sourceStrings, existingTranslations)

    if (changed.length === 0) {
      for (const str of group.strings) {
        const key = str.objectPath.join('.') || str.path
        allTranslatedStrings.push({
          path: str.path,
          value: existingTranslations.get(key) ?? str.value,
        })
      }
      continue
    }

    hasWorkItems = true
    workItems.push({
      label: `${relativePath} "${group.groupKey}"`,
      execute: async (translator: Translator) => {
        const translatedChanged = await translator.translateGroupWithContext(
          group.groupKey,
          changed,
          context,
        )

        const translatedMap = new Map(translatedChanged.map((s) => [s.key, s.value]))
        const contextMap = new Map(context.map((s) => [s.key, s.value]))

        for (const str of group.strings) {
          const key = str.objectPath.join('.') || str.path
          const translatedValue =
            translatedMap.get(key) ?? contextMap.get(key) ?? str.value
          allTranslatedStrings.push({ path: str.path, value: translatedValue })
        }

        return {
          filePath,
          write: async () => {
            const freshContent = await readFile(filePath, 'utf-8')
            const freshAST = await parseJS(freshContent, isTypeScript)
            const translatedContent = await reconstructJS(freshAST, allTranslatedStrings)
            await writeOutput(config, filePath, translatedContent, targetLang)
          },
        }
      },
    })
  }

  if (!hasWorkItems && allTranslatedStrings.length > 0) {
    return []
  }

  return workItems
}
