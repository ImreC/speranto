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
  splitLargeGroups,
  type SplitGroup,
} from './parsers/json'
import {
  parseJS,
  extractTranslatableGroupsJS,
  reconstructJS,
  splitLargeGroupsJS,
  type SplitJSGroup,
} from './parsers/js'
import { Translator } from './translator'
import { orchestrateDatabase } from './orchestrate-database'
import {
  FileStateStore,
  type StoredFileGroupState,
  type StoredMarkdownChunkState,
} from './util/file-state'
import { createContentHash, createHashMetadata, type HashEntry } from './util/hash'
import type { Config, FileConfig } from './types'
import type { Root, BlockContent } from 'mdast'

interface FileTranslateConfig extends Config {
  files: FileConfig
}

export async function orchestrate(config: Config, version: string) {
  if (config.files) {
    await translateFiles(config as FileTranslateConfig)
  }

  if (config.database) {
    await orchestrateDatabase(config)
  }
}

async function translateFiles(config: FileTranslateConfig) {
  const { files } = config
  const extensions = ['md', 'json', 'js', 'ts']
  const concurrency = config.concurrency ?? 5

  const patterns = extensions.map((ext) =>
    files.useLangCodeAsFilename
      ? join(files.sourceDir, `**/${config.sourceLang}.${ext}`)
      : join(files.sourceDir, `**/*.${ext}`),
  )
  const allFiles = (await Promise.all(patterns.map((pattern) => glob(pattern)))).flat()

  if (allFiles.length === 0) return

  for (const targetLang of config.targetLangs) {
    const translator = new Translator({
      model: config.model,
      sourceLang: config.sourceLang,
      targetLang,
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeout: config.timeout,
      llm: config.llm,
      instructionsDir: config.instructionsDir,
      retranslate: config.retranslate,
    })
    const stateStore = new FileStateStore(getFileStateRoot(config), targetLang)
    await stateStore.load()

    const fileWorkMap = new Map<
      string,
      { filePath: string; items: WorkItem[] }
    >()

    for (const filePath of allFiles) {
      const items = await collectFileWorkItemsForFile(filePath, config, targetLang, stateStore)
      if (items.length > 0) {
        const relPath = relative(files.sourceDir, filePath)
        fileWorkMap.set(relPath, { filePath, items })
      }
    }

    if (fileWorkMap.size === 0) continue

    const results: Array<{ filePath: string; write: () => Promise<void> }> = []

    const tasks = Array.from(fileWorkMap.entries()).map(([relPath, { items }]) => ({
      title: `${relPath} — ${items.length} groups`,
      task: async (_ctx: unknown, task: any) => {
        let done = 0
        await runConcurrent(items, concurrency, async (item) => {
          const result = await item.execute(translator)
          results.push(result)
          done++
          task.title = `${relPath} — ${done}/${items.length} groups`
        })
        task.title = `${relPath} — ${items.length} groups`
      },
    }))

    tasks.push({
      title: 'Writing output',
      task: async () => {
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
        await stateStore.save()
      },
    })

    const listr = new Listr(tasks, {
      concurrent: false,
      exitOnError: false,
      rendererOptions: { collapseSubtasks: true },
    } as any)

    console.log(`\nFiles → ${targetLang}`)
    await listr.run()
  }
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const errors: Error[] = []
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      try {
        await fn(items[current]!)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })
  await Promise.all(workers)
  if (errors.length > 0) {
    const msg = `${errors.length} item(s) failed: ${errors.map((e) => e.message).join('; ')}`
    console.warn(msg)
  }
}

interface WorkItem {
  label: string
  execute: (translator: Translator) => Promise<{ filePath: string; write: () => Promise<void> }>
}

async function collectFileWorkItemsForFile(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  stateStore: FileStateStore,
): Promise<WorkItem[]> {
  const ext = extname(filePath)

  if (ext === '.md') {
    return collectMarkdownWorkItems(filePath, config, targetLang, stateStore)
  } else if (ext === '.json') {
    return collectJSONWorkItems(filePath, config, targetLang, stateStore)
  } else if (ext === '.js' || ext === '.ts') {
    return collectJSWorkItems(filePath, config, targetLang, ext === '.ts', stateStore)
  }

  return []
}

function getFileStateRoot(config: FileTranslateConfig): string {
  return join(dirname(config.files.sourceDir), '.speranto')
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
  stateStore: FileStateStore,
): Promise<WorkItem[]> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const targetPath = getTargetPath(config, filePath, targetLang)
  const sourceFileHash = createContentHash(content)
  const existingState = !config.retranslate ? stateStore.get(relativePath) : undefined

  if (existingState?.fileHash === sourceFileHash && existsSync(targetPath)) {
    return []
  }

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  if (chunks.length === 0) return []

  const translatedChunks = new Map<string, string>()
  const nextChunkStates: Record<string, StoredMarkdownChunkState> = {}
  const workItems: WorkItem[] = []

  for (const [index, chunk] of chunks.entries()) {
    const chunkId = getMarkdownChunkStateId(index)
    const hashMetadata = createHashMetadata([{ key: 'text', value: chunk.text }], config.sourceLang)
    const previousChunkState = existingState?.chunks?.[chunkId]

    if (previousChunkState?.rowHash === hashMetadata.rowHash) {
      translatedChunks.set(chunkId, previousChunkState.translatedText)
      nextChunkStates[chunkId] = previousChunkState
      continue
    }

    workItems.push({
      label: `${relativePath} chunk ${index + 1}/${chunks.length}`,
      execute: async (translator: Translator) => {
        const translatedText = await translator.translateChunk(chunk)
        translatedChunks.set(chunkId, translatedText)
        nextChunkStates[chunkId] = {
          rowHash: hashMetadata.rowHash,
          translatedText,
        }

        return {
          filePath,
          write: async () => {
            const translatedTree: Root = JSON.parse(JSON.stringify(tree))

            for (const [currentIndex, currentChunk] of chunks.entries()) {
              const currentChunkId = getMarkdownChunkStateId(currentIndex)
              const translatedChunkText =
                translatedChunks.get(currentChunkId) ?? currentChunk.text
              const translatedNodes = await parseMarkdown(translatedChunkText)

              let nodeIndex = 0
              for (
                let j = currentChunk.startIndex;
                j <= currentChunk.endIndex && j < translatedTree.children.length;
                j++
              ) {
                if (nodeIndex < translatedNodes.children.length) {
                  translatedTree.children[j] =
                    translatedNodes.children[nodeIndex] as BlockContent
                  nodeIndex++
                }
              }
            }

            let translatedContent = await stringifyMarkdown(translatedTree)
            translatedContent += `\n\n_Translated automatically with ${config.model}. The original content was written in ${config.sourceLang}. Please allow for minor errors._`
            await writeOutput(config, filePath, translatedContent, targetLang)
            stateStore.set(relativePath, {
              fileHash: sourceFileHash,
              format: 'md',
              chunks: nextChunkStates,
            })
          },
        }
      },
    })
  }

  if (workItems.length === 0) {
    if (!existsSync(targetPath)) {
      return [
        {
          label: `${relativePath} restore`,
          execute: async () => ({
            filePath,
            write: async () => {
              const translatedTree: Root = JSON.parse(JSON.stringify(tree))

              for (const [index, chunk] of chunks.entries()) {
                const chunkId = getMarkdownChunkStateId(index)
                const translatedChunkText = translatedChunks.get(chunkId) ?? chunk.text
                const translatedNodes = await parseMarkdown(translatedChunkText)

                let nodeIndex = 0
                for (
                  let j = chunk.startIndex;
                  j <= chunk.endIndex && j < translatedTree.children.length;
                  j++
                ) {
                  if (nodeIndex < translatedNodes.children.length) {
                    translatedTree.children[j] =
                      translatedNodes.children[nodeIndex] as BlockContent
                    nodeIndex++
                  }
                }
              }

              let translatedContent = await stringifyMarkdown(translatedTree)
              translatedContent += `\n\n_Translated automatically with ${config.model}. The original content was written in ${config.sourceLang}. Please allow for minor errors._`
              await writeOutput(config, filePath, translatedContent, targetLang)
              stateStore.set(relativePath, {
                fileHash: sourceFileHash,
                format: 'md',
                chunks: nextChunkStates,
              })
            },
          }),
        },
      ]
    }

    return []
  }

  return workItems
}

async function collectJSONWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  stateStore: FileStateStore,
): Promise<WorkItem[]> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const targetPath = getTargetPath(config, filePath, targetLang)
  const sourceFileHash = createContentHash(content)
  const existingState = !config.retranslate ? stateStore.get(relativePath) : undefined

  if (existingState?.fileHash === sourceFileHash && existsSync(targetPath)) {
    return []
  }

  const jsonData = await parseJSON(content)
  const groups = await extractTranslatableGroups(jsonData, config.files.excludeKeys)

  const splitGroups: SplitGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroups(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])

  const workItems: WorkItem[] = []
  const allTranslatedStrings: Array<{ path: string[]; value: string }> = []
  const nextGroupStates: Record<string, StoredFileGroupState> = {}

  for (const group of allGroups) {
    const sourceStrings: HashEntry[] = group.strings.map((str) => ({
      key: str.path.join('.'),
      value: str.value,
    }))
    const groupId = getFileGroupStateId(group.groupKey, sourceStrings.map((str) => str.key))
    const hashMetadata = createHashMetadata(sourceStrings, config.sourceLang)
    const previousGroupState = existingState?.groups?.[groupId]

    if (previousGroupState?.rowHash === hashMetadata.rowHash) {
      nextGroupStates[groupId] = previousGroupState
      for (const str of group.strings) {
        allTranslatedStrings.push({
          path: str.path,
          value: previousGroupState.translations[str.path.join('.')] ?? str.value,
        })
      }
      continue
    }

    const preparedGroup = prepareGroupedTranslations(
      sourceStrings,
      hashMetadata.fieldHashes,
      previousGroupState,
    )

    if (preparedGroup.changed.length === 0) {
      nextGroupStates[groupId] = {
        rowHash: hashMetadata.rowHash,
        fieldHashes: hashMetadata.fieldHashes,
        translations: preparedGroup.translations,
      }
      for (const str of group.strings) {
        allTranslatedStrings.push({
          path: str.path,
          value: preparedGroup.translations[str.path.join('.')] ?? str.value,
        })
      }
      continue
    }

    workItems.push({
      label: `${relativePath} "${group.groupKey}"`,
      execute: async (translator: Translator) => {
        const translatedChanged = await translator.translateGroupWithContext(
          group.groupKey,
          preparedGroup.changed,
          preparedGroup.context,
        )

        const translatedMap = new Map(translatedChanged.map((s) => [s.key, s.value]))
        const translations = { ...preparedGroup.translations }

        for (const str of group.strings) {
          const key = str.path.join('.')
          const translatedValue = translatedMap.get(key) ?? translations[key] ?? str.value
          translations[key] = translatedValue
          allTranslatedStrings.push({
            path: str.path,
            value: translatedValue,
          })
        }

        nextGroupStates[groupId] = {
          rowHash: hashMetadata.rowHash,
          fieldHashes: hashMetadata.fieldHashes,
          translations,
        }

        return {
          filePath,
          write: async () => {
            const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
            const translatedContent = await stringifyJSON(translatedJSON)
            await writeOutput(config, filePath, translatedContent, targetLang)
            stateStore.set(relativePath, {
              fileHash: sourceFileHash,
              format: 'json',
              groups: nextGroupStates,
            })
          },
        }
      },
    })
  }

  if (workItems.length === 0 && allTranslatedStrings.length > 0) {
    if (!existsSync(targetPath)) {
      return [
        {
          label: `${relativePath} restore`,
          execute: async () => ({
            filePath,
            write: async () => {
              const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
              const translatedContent = await stringifyJSON(translatedJSON)
              await writeOutput(config, filePath, translatedContent, targetLang)
              stateStore.set(relativePath, {
                fileHash: sourceFileHash,
                format: 'json',
                groups: nextGroupStates,
              })
            },
          }),
        },
      ]
    }

    return []
  }

  return workItems
}

async function collectJSWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  isTypeScript: boolean,
  stateStore: FileStateStore,
): Promise<WorkItem[]> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const targetPath = getTargetPath(config, filePath, targetLang)
  const sourceFileHash = createContentHash(content)
  const existingState = !config.retranslate ? stateStore.get(relativePath) : undefined

  if (existingState?.fileHash === sourceFileHash && existsSync(targetPath)) {
    return []
  }

  const ast = await parseJS(content, isTypeScript)
  const groups = await extractTranslatableGroupsJS(ast, config.files.excludeKeys)

  const splitGroups: SplitJSGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroupsJS(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])

  const workItems: WorkItem[] = []
  const allTranslatedStrings: Array<{ path: string; value: string }> = []
  const nextGroupStates: Record<string, StoredFileGroupState> = {}

  for (const group of allGroups) {
    const sourceStrings: HashEntry[] = group.strings.map((str) => ({
      key: str.objectPath.join('.') || str.path,
      value: str.value,
    }))
    const groupId = getFileGroupStateId(group.groupKey, sourceStrings.map((str) => str.key))
    const hashMetadata = createHashMetadata(sourceStrings, config.sourceLang)
    const previousGroupState = existingState?.groups?.[groupId]

    if (previousGroupState?.rowHash === hashMetadata.rowHash) {
      nextGroupStates[groupId] = previousGroupState
      for (const str of group.strings) {
        const key = str.objectPath.join('.') || str.path
        allTranslatedStrings.push({
          path: str.path,
          value: previousGroupState.translations[key] ?? str.value,
        })
      }
      continue
    }

    const preparedGroup = prepareGroupedTranslations(
      sourceStrings,
      hashMetadata.fieldHashes,
      previousGroupState,
    )

    if (preparedGroup.changed.length === 0) {
      nextGroupStates[groupId] = {
        rowHash: hashMetadata.rowHash,
        fieldHashes: hashMetadata.fieldHashes,
        translations: preparedGroup.translations,
      }
      for (const str of group.strings) {
        const key = str.objectPath.join('.') || str.path
        allTranslatedStrings.push({
          path: str.path,
          value: preparedGroup.translations[key] ?? str.value,
        })
      }
      continue
    }

    workItems.push({
      label: `${relativePath} "${group.groupKey}"`,
      execute: async (translator: Translator) => {
        const translatedChanged = await translator.translateGroupWithContext(
          group.groupKey,
          preparedGroup.changed,
          preparedGroup.context,
        )

        const translatedMap = new Map(translatedChanged.map((s) => [s.key, s.value]))
        const translations = { ...preparedGroup.translations }

        for (const str of group.strings) {
          const key = str.objectPath.join('.') || str.path
          const translatedValue = translatedMap.get(key) ?? translations[key] ?? str.value
          translations[key] = translatedValue
          allTranslatedStrings.push({ path: str.path, value: translatedValue })
        }

        nextGroupStates[groupId] = {
          rowHash: hashMetadata.rowHash,
          fieldHashes: hashMetadata.fieldHashes,
          translations,
        }

        return {
          filePath,
          write: async () => {
            const freshAST = await parseJS(content, isTypeScript)
            const translatedContent = await reconstructJS(freshAST, allTranslatedStrings)
            await writeOutput(config, filePath, translatedContent, targetLang)
            stateStore.set(relativePath, {
              fileHash: sourceFileHash,
              format: 'js',
              groups: nextGroupStates,
            })
          },
        }
      },
    })
  }

  if (workItems.length === 0 && allTranslatedStrings.length > 0) {
    if (!existsSync(targetPath)) {
      return [
        {
          label: `${relativePath} restore`,
          execute: async () => ({
            filePath,
            write: async () => {
              const freshAST = await parseJS(content, isTypeScript)
              const translatedContent = await reconstructJS(freshAST, allTranslatedStrings)
              await writeOutput(config, filePath, translatedContent, targetLang)
              stateStore.set(relativePath, {
                fileHash: sourceFileHash,
                format: 'js',
                groups: nextGroupStates,
              })
            },
          }),
        },
      ]
    }

    return []
  }

  return workItems
}

function getFileGroupStateId(groupKey: string, keys: string[]): string {
  return `${groupKey}::${keys.join('|')}`
}

function getMarkdownChunkStateId(index: number): string {
  return `chunk_${index}`
}

function prepareGroupedTranslations(
  sourceStrings: HashEntry[],
  fieldHashes: Record<string, string>,
  previousGroupState?: StoredFileGroupState,
): {
  changed: HashEntry[]
  context: HashEntry[]
  translations: Record<string, string>
} {
  const changed: HashEntry[] = []
  const context: HashEntry[] = []
  const translations: Record<string, string> = {}

  for (const { key, value } of sourceStrings) {
    const existingHash = previousGroupState?.fieldHashes[key]
    const existingTranslation = previousGroupState?.translations[key]

    if (existingHash === fieldHashes[key] && existingTranslation !== undefined) {
      context.push({ key, value: existingTranslation })
      translations[key] = existingTranslation
      continue
    }

    changed.push({ key, value })
  }

  return { changed, context, translations }
}
