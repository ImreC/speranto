import { glob } from 'glob'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative, extname } from 'path'
import { Listr } from 'listr2'
import { getTranslatableChunks, parseMarkdown, stringifyMarkdown } from './parsers/md'
import {
  parseJSON,
  stringifyJSON,
  extractTranslatableGroups,
  reconstructJSON,
  type TranslatableGroup,
} from './parsers/json'
import {
  parseJS,
  extractTranslatableGroupsJS,
  reconstructJS,
  type TranslatableJSGroup,
} from './parsers/js'
import { Translator } from './translator'
import { translateDatabaseTasks } from './translate-database'
import type { Config, FileConfig } from './types'
import type { Root, BlockContent } from 'mdast'

interface FileTranslateConfig extends Config {
  files: FileConfig
}

export async function translate(config: Config) {
  const tasks: Array<{ title: string; task: () => Listr }> = []

  if (config.files) {
    tasks.push({
      title: 'Files',
      task: () => translateFiles(config as FileTranslateConfig),
    })
  }

  if (config.database) {
    tasks.push({
      title: 'Database',
      task: () => translateDatabaseTasks(config),
    })
  }

  if (tasks.length === 0) {
    console.log('No translation sources configured. Add "files" or "database" to your config.')
    return
  }

  console.log(`Using ${config.provider || 'ollama'} provider`)

  const listr = new Listr(tasks, {
    concurrent: true,
    renderer: config.verbose ? 'verbose' : 'default',
  } as any)

  await listr.run()
}

function translateFiles(config: FileTranslateConfig): Listr {
  const { files } = config
  const extensions = ['md', 'json', 'js', 'ts']

  return new Listr([
    {
      title: 'Scanning files',
      task: async (ctx) => {
        const patterns = extensions.map((ext) =>
          files.useLangCodeAsFilename
            ? join(files.sourceDir, `**/${config.sourceLang}.${ext}`)
            : join(files.sourceDir, `**/*.${ext}`),
        )
        const allFiles = await Promise.all(patterns.map((pattern) => glob(pattern)))
        ctx.fileList = allFiles.flat()
      },
    },
    {
      title: 'Translating files',
      skip: (ctx) => ctx.fileList.length === 0 && 'No files found',
      task: (ctx, task) => {
        const translators = new Map(
          config.targetLangs.map((lang) => [
            lang,
            new Translator({
              model: config.model,
              temperature: config.temperature,
              sourceLang: config.sourceLang,
              targetLang: lang,
              provider: config.provider,
              apiKey: config.apiKey,
              llm: config.llm,
            }),
          ]),
        )

        return task.newListr(
          ctx.fileList.map((file: string) => {
            const ext = extname(file)
            const relativePath = relative(files.sourceDir, file)

            return {
              title: relativePath,
              task: (_ctx: unknown, fileTask: any) =>
                fileTask.newListr(
                  config.targetLangs.map((targetLang) => ({
                    title: targetLang,
                    task: async (_ctx: unknown, langTask: any) => {
                      const translator = translators.get(targetLang)!
                      if (ext === '.md') {
                        return translateMarkdownFile(file, config, targetLang, translator, langTask)
                      } else if (ext === '.json') {
                        return translateJSONFile(file, config, targetLang, translator, langTask)
                      } else if (ext === '.js' || ext === '.ts') {
                        return translateJSFile(
                          file,
                          config,
                          targetLang,
                          translator,
                          ext === '.ts',
                          langTask,
                        )
                      }
                    },
                  })),
                  { concurrent: true },
                ),
            }
          }),
          { concurrent: false },
        )
      },
    },
  ])
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
  translatedContent: string,
  targetLang: string,
) {
  const targetPath = getTargetPath(config, filePath, targetLang)
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, translatedContent, 'utf-8')
}

async function translateMarkdownFile(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  translator: Translator,
  task: any,
) {
  const content = await readFile(filePath, 'utf-8')
  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  task.title = `${targetLang}: ${chunks.length} chunks`

  const translatedTree: Root = JSON.parse(JSON.stringify(tree))

  const translatedChunks = await Promise.all(
    chunks.map(async (chunk) => ({
      ...chunk,
      text: await translator.translateChunk(chunk),
    })),
  )

  for (const translatedChunk of translatedChunks) {
    const translatedNodes = await parseMarkdown(translatedChunk.text)
    let nodeIndex = 0
    for (
      let i = translatedChunk.startIndex;
      i <= translatedChunk.endIndex && i < translatedTree.children.length;
      i++
    ) {
      if (nodeIndex < translatedNodes.children.length) {
        translatedTree.children[i] = translatedNodes.children[nodeIndex] as BlockContent
        nodeIndex++
      }
    }
  }

  let translatedContent = await stringifyMarkdown(translatedTree)
  translatedContent += `\n\n_Translated automatically with ${config.model}. The original content was written in ${config.sourceLang}. Please allow for minor errors._`

  await writeOutput(config, filePath, translatedContent, targetLang)
}

interface BaseGroup {
  groupKey: string
  strings: Array<{ value: string }>
}

function hasGroupChanged<T extends BaseGroup>(
  sourceGroup: T,
  existingGroups: T[],
  getKey: (str: T['strings'][number]) => string,
): boolean {
  const existingGroup = existingGroups.find((g) => g.groupKey === sourceGroup.groupKey)
  if (!existingGroup) return true
  if (sourceGroup.strings.length !== existingGroup.strings.length) return true

  for (const sourceString of sourceGroup.strings) {
    const sourceKey = getKey(sourceString)
    if (!existingGroup.strings.find((s) => getKey(s) === sourceKey)) return true
  }

  return false
}

function updateTaskTitle<T extends BaseGroup>(
  task: any,
  targetLang: string,
  groups: T[],
  changedGroups: T[],
  unchangedGroups: T[],
) {
  if (changedGroups.length === 0) {
    task.skip(`${targetLang}: ${groups.length}/${groups.length} groups unchanged`)
    return false
  }

  task.title =
    `${targetLang}: translating ${changedGroups.length}/${groups.length} groups` +
    (unchangedGroups.length > 0
      ? `, ${unchangedGroups.length}/${groups.length} groups unchanged. Skipping...`
      : '')
  return true
}

async function translateJSONFile(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  translator: Translator,
  task: any,
) {
  const content = await readFile(filePath, 'utf-8')
  const jsonData = await parseJSON(content)
  const groups = await extractTranslatableGroups(jsonData)

  const targetPath = getTargetPath(config, filePath, targetLang)
  const existingTranslations = new Map<string, string>()
  let existingGroups: TranslatableGroup[] = []

  if (existsSync(targetPath)) {
    try {
      const existingContent = await readFile(targetPath, 'utf-8')
      const existingJSON = await parseJSON(existingContent)
      existingGroups = await extractTranslatableGroups(existingJSON)

      for (const group of existingGroups) {
        for (const str of group.strings) {
          existingTranslations.set(str.path.join('.'), str.value)
        }
      }
    } catch {
      // Could not parse existing, will retranslate all
    }
  }

  const getKey = (str: { path: string[] }) => str.path.join('.')
  const changedGroups = groups.filter((g) => hasGroupChanged(g, existingGroups, getKey))
  const unchangedGroups = groups.filter((g) => !hasGroupChanged(g, existingGroups, getKey))

  if (!updateTaskTitle(task, targetLang, groups, changedGroups, unchangedGroups)) return

  const allTranslatedStrings: Array<{ path: string[]; value: string }> = []

  for (const group of unchangedGroups) {
    for (const str of group.strings) {
      allTranslatedStrings.push({
        path: str.path,
        value: existingTranslations.get(str.path.join('.')) ?? str.value,
      })
    }
  }

  const errors: Array<{ group: string; error: string }> = []

  return task.newListr(
    [
      {
        title: `Translating ${changedGroups.length} groups`,
        task: (_: unknown, groupsTask: any) =>
          groupsTask.newListr(
            changedGroups.map((group) => ({
              title: `"${group.groupKey}" (${group.strings.length} strings)`,
              task: async () => {
                const groupStrings = group.strings.map((str) => ({
                  key: str.path.join('.'),
                  value: str.value,
                }))

                try {
                  const translatedGroupStrings = await translator.translateGroup(
                    group.groupKey,
                    groupStrings,
                  )

                  for (let i = 0; i < group.strings.length; i++) {
                    allTranslatedStrings.push({
                      path: group.strings[i]!.path,
                      value: translatedGroupStrings[i]!.value,
                    })
                  }
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  errors.push({ group: group.groupKey, error: message })
                  // Keep original strings on error
                  for (const str of group.strings) {
                    allTranslatedStrings.push({ path: str.path, value: str.value })
                  }
                  throw err
                }
              },
            })),
            { concurrent: true, exitOnError: false },
          ),
      },
      {
        title: 'Writing output',
        task: async () => {
          const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
          const translatedContent = await stringifyJSON(translatedJSON)
          await writeOutput(config, filePath, translatedContent, targetLang)
        },
      },
    ],
    { concurrent: false },
  )
}

async function translateJSFile(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  translator: Translator,
  isTypeScript: boolean,
  task: any,
) {
  const content = await readFile(filePath, 'utf-8')
  const ast = await parseJS(content, isTypeScript)
  const groups = await extractTranslatableGroupsJS(ast)

  const targetPath = getTargetPath(config, filePath, targetLang)
  const existingTranslations = new Map<string, string>()
  let existingGroups: TranslatableJSGroup[] = []

  if (existsSync(targetPath)) {
    try {
      const existingContent = await readFile(targetPath, 'utf-8')
      const existingAST = await parseJS(existingContent, isTypeScript)
      existingGroups = await extractTranslatableGroupsJS(existingAST)

      for (const group of existingGroups) {
        for (const str of group.strings) {
          existingTranslations.set(str.objectPath.join('.') || str.path, str.value)
        }
      }
    } catch {
      // Could not parse existing, will retranslate all
    }
  }

  const getKey = (str: { path: string; objectPath: string[] }) =>
    str.objectPath.join('.') || str.path
  const changedGroups = groups.filter((g) => hasGroupChanged(g, existingGroups, getKey))
  const unchangedGroups = groups.filter((g) => !hasGroupChanged(g, existingGroups, getKey))

  if (!updateTaskTitle(task, targetLang, groups, changedGroups, unchangedGroups)) return

  const allTranslatedStrings: Array<{ path: string; value: string }> = []

  for (const group of unchangedGroups) {
    for (const str of group.strings) {
      const key = str.objectPath.join('.') || str.path
      allTranslatedStrings.push({
        path: str.path,
        value: existingTranslations.get(key) ?? str.value,
      })
    }
  }

  const errors: Array<{ group: string; error: string }> = []

  return task.newListr(
    [
      {
        title: `Translating ${changedGroups.length} groups`,
        task: (_: unknown, groupsTask: any) =>
          groupsTask.newListr(
            changedGroups.map((group) => ({
              title: `"${group.groupKey}" (${group.strings.length} strings)`,
              task: async () => {
                const groupStrings = group.strings.map((str) => ({
                  key: str.objectPath.length > 0 ? str.objectPath.join('.') : str.path,
                  value: str.value,
                }))

                try {
                  const translatedGroupStrings = await translator.translateGroup(
                    group.groupKey,
                    groupStrings,
                  )

                  for (let i = 0; i < group.strings.length; i++) {
                    allTranslatedStrings.push({
                      path: group.strings[i]!.path,
                      value: translatedGroupStrings[i]!.value,
                    })
                  }
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  errors.push({ group: group.groupKey, error: message })
                  // Keep original strings on error
                  for (const str of group.strings) {
                    allTranslatedStrings.push({ path: str.path, value: str.value })
                  }
                  throw err
                }
              },
            })),
            { concurrent: true, exitOnError: false },
          ),
      },
      {
        title: 'Writing output',
        task: async () => {
          const translatedContent = await reconstructJS(ast, allTranslatedStrings)
          await writeOutput(config, filePath, translatedContent, targetLang)
        },
      },
    ],
    { concurrent: false },
  )
}
