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
  mergeExcludedKeys,
  splitLargeGroups,
  type SplitGroup,
  type TranslatableJSON,
} from './parsers/json'
import {
  parseJS,
  extractTranslatableGroupsJS,
  extractTranslatableStringsJS,
  reconstructJS,
  splitLargeGroupsJS,
  type SplitJSGroup,
  type TranslatableJSString,
} from './parsers/js'
import { Translator } from './translator'
import { orchestrateDatabase } from './orchestrate-database'
import {
  FileStateStore,
  type StoredFileGroupState,
  type StoredMarkdownChunkState,
} from './util/file-state'
import { resolveConcurrency } from './util/concurrency'
import {
  ExecutionEvents,
  type ExecutionJob,
  type ProgressReporter,
} from './execution/events'
import { RequestScheduler } from './execution/scheduler'
import { createContentHash, createHashMetadata, type HashEntry } from './util/hash'
import type { Config, FileConfig } from './types'
import type { Root, BlockContent } from 'mdast'

interface FileTranslateConfig extends Config {
  files: FileConfig
}

interface FileLanguagePlan {
  targetLang: string
  stateStore: FileStateStore
  files: Map<string, { filePath: string; plan: FileWorkPlan }>
}

export async function orchestrate(
  config: Config,
  version: string,
  reporter?: ProgressReporter,
) {
  const startedAt = Date.now()
  const defaultConcurrency = isLocalEndpoint(config) ? 1 : 5
  const concurrency = resolveConcurrency(config.concurrency, defaultConcurrency, 'concurrency')
  const events = new ExecutionEvents(reporter)
  const scheduler = new RequestScheduler(concurrency, events)
  const operations: Promise<void>[] = []
  const sourceCount = Number(Boolean(config.files)) + Number(Boolean(config.database))
  const planningBarrier = new PlanningBarrier(sourceCount, events)
  events.emit({ type: 'planning-started', sourceLanguages: config.targetLangs.length })

  if (config.files) {
    operations.push(
      translateFiles(config as FileTranslateConfig, scheduler, events, planningBarrier).catch(
        (error: unknown) => {
          planningBarrier.fail(error)
          throw error
        },
      ),
    )
  }
  if (config.database) {
    operations.push(
      orchestrateDatabase(config, scheduler, events, planningBarrier).catch((error: unknown) => {
        planningBarrier.fail(error)
        throw error
      }),
    )
  }

  const results = await Promise.allSettled(operations)
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) =>
      result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
    )
  events.emit({
    type: 'run-completed',
    summary: { durationMs: Date.now() - startedAt, operationFailures: errors.length },
  })
  reporter?.finish?.()
  if (errors.length > 0) throw new AggregateError(errors, formatAggregateError(errors))
}

export interface PlanningBarrierLike {
  arrive(): Promise<void>
  fail(error: unknown): void
}

class PlanningBarrier implements PlanningBarrierLike {
  private remaining: number
  private resolve!: () => void
  private reject!: (error: unknown) => void
  private completed: Promise<void>
  private settled = false

  constructor(sourceCount: number, private events: ExecutionEvents) {
    this.remaining = sourceCount
    this.completed = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    if (sourceCount === 0) {
      this.settled = true
      this.resolve()
    }
  }

  async arrive(): Promise<void> {
    this.remaining--
    if (this.remaining === 0 && !this.settled) {
      this.settled = true
      this.events.emit({ type: 'planning-completed' })
      this.resolve()
    }
    await this.completed
  }

  fail(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.reject(error)
  }
}

function isLocalEndpoint(config: Config): boolean {
  if (config.provider === 'ollama') return true
  if (!config.baseUrl) return false

  try {
    const hostname = new URL(config.baseUrl).hostname
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

async function translateFiles(
  config: FileTranslateConfig,
  scheduler: RequestScheduler,
  events: ExecutionEvents,
  planningBarrier: PlanningBarrierLike,
) {
  const { files } = config
  const extensions = ['md', 'json', 'js', 'ts']

  const patterns = extensions.map((ext) =>
    files.useLangCodeAsFilename
      ? join(files.sourceDir, `**/${config.sourceLang}.${ext}`)
      : join(files.sourceDir, `**/*.${ext}`),
  )
  const allFiles = (await Promise.all(patterns.map((pattern) => glob(pattern)))).flat()

  if (allFiles.length === 0) {
    await planningBarrier.arrive()
    return
  }

  if (config.init) {
    for (const targetLang of config.targetLangs) {
      for (const filePath of allFiles) {
        const relativePath = relative(files.sourceDir, filePath)
        if (!existsSync(getTargetPath(config, filePath, targetLang))) continue
        events.emit({
          type: 'scope-planned',
          scope: {
            id: `file:${targetLang}:${relativePath}`,
            label: relativePath,
            source: 'file',
            targetLang,
            jobs: 0,
            pending: 0,
            reused: 0,
          },
        })
      }
    }
    await planningBarrier.arrive()
    await initFiles(config, allFiles)
    return
  }

  const plans = await Promise.all(
    config.targetLangs.map(async (targetLang): Promise<FileLanguagePlan> => {
      const stateStore = new FileStateStore(getFileStateRoot(), targetLang)
      await stateStore.load()

      const fileWorkMap = new Map<string, { filePath: string; plan: FileWorkPlan }>()

      for (const filePath of allFiles) {
        const plan = await collectFileWorkItemsForFile(filePath, config, targetLang, stateStore)
        const relPath = relative(files.sourceDir, filePath)
        fileWorkMap.set(relPath, { filePath, plan })
        events.emit({
          type: 'scope-planned',
          scope: {
            id: `file:${targetLang}:${relPath}`,
            label: relPath,
            source: 'file',
            targetLang,
            jobs: plan.totalJobs,
            pending: plan.items.filter((item) => item.translates).length,
            reused: plan.reusedJobs,
            writesFile: plan.items.length > 0,
          },
        })
      }

      return { targetLang, stateStore, files: fileWorkMap }
    }),
  )

  await planningBarrier.arrive()

  const languageResults = await Promise.allSettled(
    plans.map(async ({ targetLang, stateStore, files: fileWorkMap }) => {
      const needsTranslator = Array.from(fileWorkMap.values()).some(({ plan }) =>
        plan.items.some((item) => item.translates),
      )
      const translator = needsTranslator
        ? new Translator({
            model: config.model,
            sourceLang: config.sourceLang,
            targetLang,
            provider: config.provider,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            timeout: config.timeout,
            ollama: config.ollama,
            llm: config.llm,
            instructionsDir: config.instructionsDir,
            retranslate: config.retranslate,
            scheduler,
            job: {
              id: `files:${targetLang}`,
              label: `Files → ${targetLang}`,
              source: 'file',
              targetLang,
              kind: 'setup',
            },
          })
        : undefined
      const fileResults = await Promise.allSettled(
        Array.from(fileWorkMap.entries()).map(async ([relativePath, { plan }]) => {
          const { items } = plan
          if (items.length === 0) return
          const results = await Promise.allSettled(
            items.map((item) => executeFileWorkItem(item, translator, events)),
          )
          const errors = settledErrors(results)
          if (errors.length > 0) {
            throw new AggregateError(errors, formatAggregateError(errors))
          }

          const firstResult = results.find(
            (result): result is PromiseFulfilledResult<{
              filePath: string
              write: () => Promise<void>
            }> => result.status === 'fulfilled',
          )
          await firstResult?.value.write()
          events.emit({ type: 'file-committed', targetLang, file: relativePath })
        }),
      )
      await stateStore.save()

      const errors = settledErrors(fileResults)
      if (errors.length > 0) throw new AggregateError(errors, formatAggregateError(errors))
    }),
  )

  const errors = settledErrors(languageResults)
  if (errors.length > 0) throw new AggregateError(errors, formatAggregateError(errors))
}

function settledErrors(results: PromiseSettledResult<unknown>[]): Error[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) =>
      result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
    )
}

function formatAggregateError(errors: Error[]): string {
  return `${errors.length} item(s) failed: ${errors.map((error) => error.message).join('; ')}`
}

async function executeFileWorkItem(
  item: WorkItem,
  translator: Translator | undefined,
  events: ExecutionEvents,
): Promise<{ filePath: string; write: () => Promise<void> }> {
  const startedAt = Date.now()
  if (item.job) events.emit({ type: 'job-started', job: item.job })
  try {
    const result = await item.execute(translator)
    if (item.job) {
      events.emit({
        type: 'job-completed',
        job: item.job,
        durationMs: Date.now() - startedAt,
      })
    }
    return result
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    if (item.job) events.emit({ type: 'job-failed', job: item.job, error: normalizedError })
    throw normalizedError
  }
}

interface WorkItem {
  label: string
  translates: boolean
  job?: ExecutionJob
  execute: (
    translator?: Translator,
  ) => Promise<{ filePath: string; write: () => Promise<void> }>
}

interface FileWorkPlan {
  items: WorkItem[]
  totalJobs: number
  reusedJobs: number
}

async function collectFileWorkItemsForFile(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  stateStore: FileStateStore,
): Promise<FileWorkPlan> {
  const ext = extname(filePath)

  if (ext === '.md') {
    return collectMarkdownWorkItems(filePath, config, targetLang, stateStore)
  } else if (ext === '.json') {
    return collectJSONWorkItems(filePath, config, targetLang, stateStore)
  } else if (ext === '.js' || ext === '.ts') {
    return collectJSWorkItems(filePath, config, targetLang, ext === '.ts', stateStore)
  }

  return { items: [], totalJobs: 0, reusedJobs: 0 }
}

function getFileStateRoot(): string {
  return join(process.cwd(), '.speranto')
}

function getTargetPath(
  config: FileTranslateConfig,
  filePath: string,
  targetLang: string,
): string {
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
): Promise<FileWorkPlan> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const targetPath = getTargetPath(config, filePath, targetLang)
  const sourceFileHash = createContentHash(content)
  const existingState = !config.retranslate ? stateStore.get(relativePath) : undefined

  if (existingState?.fileHash === sourceFileHash && existsSync(targetPath)) {
    const totalJobs = Object.keys(existingState.chunks ?? {}).length
    return { items: [], totalJobs, reusedJobs: totalJobs }
  }

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  if (chunks.length === 0) return { items: [], totalJobs: 0, reusedJobs: 0 }

  const translatedChunks = new Map<string, string>()
  const nextChunkStates: Record<string, StoredMarkdownChunkState> = {}
  const workItems: WorkItem[] = []

  for (const [index, chunk] of chunks.entries()) {
    const chunkId = getMarkdownChunkStateId(index)
    const hashMetadata = createHashMetadata(
      [{ key: 'text', value: chunk.text }],
      config.sourceLang,
    )
    const previousChunkState = existingState?.chunks?.[chunkId]

    if (previousChunkState?.rowHash === hashMetadata.rowHash) {
      translatedChunks.set(chunkId, previousChunkState.translatedText)
      nextChunkStates[chunkId] = previousChunkState
      continue
    }

    workItems.push({
      label: `${relativePath} chunk ${index + 1}/${chunks.length}`,
      translates: true,
      job: {
        id: `file:${targetLang}:${relativePath}:chunk:${index}`,
        label: `${relativePath} › chunk ${index + 1}/${chunks.length}`,
        source: 'file',
        targetLang,
        kind: 'translation',
        file: relativePath,
        group: `chunk ${index + 1}`,
      },
      execute: async (translator?: Translator) => {
        const translatedText = await translator!.translateChunk(chunk, {
          id: `file:${targetLang}:${relativePath}:chunk:${index}`,
          label: `${relativePath} › chunk ${index + 1}/${chunks.length}`,
          source: 'file',
          targetLang,
          kind: 'translation',
          file: relativePath,
          group: `chunk ${index + 1}`,
        })
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
                  translatedTree.children[j] = translatedNodes.children[
                    nodeIndex
                  ] as BlockContent
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
      return {
        totalJobs: chunks.length,
        reusedJobs: chunks.length,
        items: [
        {
          label: `${relativePath} restore`,
          translates: false,
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
                    translatedTree.children[j] = translatedNodes.children[
                      nodeIndex
                    ] as BlockContent
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
        ],
      }
    }

    return { items: [], totalJobs: chunks.length, reusedJobs: chunks.length }
  }

  return {
    items: workItems,
    totalJobs: chunks.length,
    reusedJobs: chunks.length - workItems.length,
  }
}

async function collectJSONWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  stateStore: FileStateStore,
): Promise<FileWorkPlan> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const targetPath = getTargetPath(config, filePath, targetLang)
  const sourceFileHash = createContentHash(content)
  const existingState = !config.retranslate ? stateStore.get(relativePath) : undefined

  if (existingState?.fileHash === sourceFileHash && existsSync(targetPath)) {
    const totalJobs = Object.keys(existingState.groups ?? {}).length
    return { items: [], totalJobs, reusedJobs: totalJobs }
  }

  const jsonData = await parseJSON(content)
  const excludeKeys = config.files.excludeKeys

  let existingTargetJSON: TranslatableJSON | undefined
  if (excludeKeys?.length && existsSync(targetPath)) {
    try {
      existingTargetJSON = await parseJSON(await readFile(targetPath, 'utf-8'))
    } catch {}
  }

  const groups = await extractTranslatableGroups(jsonData, excludeKeys)

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
    const groupId = getFileGroupStateId(
      group.groupKey,
      sourceStrings.map((str) => str.key),
    )
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
      translates: true,
      job: {
        id: `file:${targetLang}:${relativePath}:${groupId}`,
        label: `${relativePath} › ${group.groupKey}`,
        source: 'file',
        targetLang,
        kind: 'translation',
        file: relativePath,
        group: group.groupKey,
      },
      execute: async (translator?: Translator) => {
        const translatedChanged = await translator!.translateGroupWithContext(
          group.groupKey,
          preparedGroup.changed,
          preparedGroup.context,
          {
            id: `file:${targetLang}:${relativePath}:${groupId}`,
            label: `${relativePath} › ${group.groupKey}`,
            source: 'file',
            targetLang,
            kind: 'translation',
            file: relativePath,
            group: group.groupKey,
          },
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
            if (excludeKeys?.length && existingTargetJSON) {
              mergeExcludedKeys(translatedJSON, existingTargetJSON, excludeKeys)
            }
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
      return {
        totalJobs: allGroups.length,
        reusedJobs: allGroups.length,
        items: [
        {
          label: `${relativePath} restore`,
          translates: false,
          execute: async () => ({
            filePath,
            write: async () => {
              const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
              if (excludeKeys?.length && existingTargetJSON) {
                mergeExcludedKeys(translatedJSON, existingTargetJSON, excludeKeys)
              }
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
        ],
      }
    }

    return { items: [], totalJobs: allGroups.length, reusedJobs: allGroups.length }
  }

  return {
    items: workItems,
    totalJobs: allGroups.length,
    reusedJobs: allGroups.length - workItems.length,
  }
}

async function collectJSWorkItems(
  filePath: string,
  config: FileTranslateConfig,
  targetLang: string,
  isTypeScript: boolean,
  stateStore: FileStateStore,
): Promise<FileWorkPlan> {
  const relativePath = relative(config.files.sourceDir, filePath)
  const content = await readFile(filePath, 'utf-8')
  const targetPath = getTargetPath(config, filePath, targetLang)
  const sourceFileHash = createContentHash(content)
  const existingState = !config.retranslate ? stateStore.get(relativePath) : undefined

  if (existingState?.fileHash === sourceFileHash && existsSync(targetPath)) {
    const totalJobs = Object.keys(existingState.groups ?? {}).length
    return { items: [], totalJobs, reusedJobs: totalJobs }
  }

  const ast = await parseJS(content, isTypeScript)
  const excludeKeys = config.files.excludeKeys
  const groups = await extractTranslatableGroupsJS(ast, excludeKeys)

  const splitGroups: SplitJSGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroupsJS(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])

  const workItems: WorkItem[] = []
  const allTranslatedStrings: Array<{ path: string; value: string }> = []
  const nextGroupStates: Record<string, StoredFileGroupState> = {}

  let excludedKeyValues: Map<string, string> | undefined
  if (excludeKeys?.length && existsSync(targetPath)) {
    try {
      const excludeSet = new Set(excludeKeys)
      const sourceAllStrings = await extractTranslatableStringsJS(
        await parseJS(content, isTypeScript),
      )
      const targetContent = await readFile(targetPath, 'utf-8')
      const targetAST = await parseJS(targetContent, isTypeScript)
      const targetAllStrings = await extractTranslatableStringsJS(targetAST)

      excludedKeyValues = new Map()
      for (let i = 0; i < sourceAllStrings.length && i < targetAllStrings.length; i++) {
        const src = sourceAllStrings[i]!
        const leafKey = src.objectPath[src.objectPath.length - 1]
        if (leafKey && excludeSet.has(leafKey)) {
          excludedKeyValues.set(src.path, targetAllStrings[i]!.value)
        }
      }
    } catch {}
  }

  for (const group of allGroups) {
    const keyedStrings = createUniqueJSTranslationKeys(group.strings)
    const sourceStrings: HashEntry[] = keyedStrings.map(({ key, string }) => ({
      key,
      value: string.value,
    }))
    const groupId = getFileGroupStateId(
      group.groupKey,
      sourceStrings.map((str) => str.key),
    )
    const hashMetadata = createHashMetadata(sourceStrings, config.sourceLang)
    const previousGroupState = existingState?.groups?.[groupId]

    if (previousGroupState?.rowHash === hashMetadata.rowHash) {
      nextGroupStates[groupId] = previousGroupState
      for (const { key, string } of keyedStrings) {
        allTranslatedStrings.push({
          path: string.path,
          value: previousGroupState.translations[key] ?? string.value,
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
      for (const { key, string } of keyedStrings) {
        allTranslatedStrings.push({
          path: string.path,
          value: preparedGroup.translations[key] ?? string.value,
        })
      }
      continue
    }

    workItems.push({
      label: `${relativePath} "${group.groupKey}"`,
      translates: true,
      job: {
        id: `file:${targetLang}:${relativePath}:${groupId}`,
        label: `${relativePath} › ${group.groupKey}`,
        source: 'file',
        targetLang,
        kind: 'translation',
        file: relativePath,
        group: group.groupKey,
      },
      execute: async (translator?: Translator) => {
        const translatedChanged = await translator!.translateGroupWithContext(
          group.groupKey,
          preparedGroup.changed,
          preparedGroup.context,
          {
            id: `file:${targetLang}:${relativePath}:${groupId}`,
            label: `${relativePath} › ${group.groupKey}`,
            source: 'file',
            targetLang,
            kind: 'translation',
            file: relativePath,
            group: group.groupKey,
          },
        )

        const translatedMap = new Map(translatedChanged.map((s) => [s.key, s.value]))
        const translations = { ...preparedGroup.translations }

        for (const { key, string } of keyedStrings) {
          const translatedValue = translatedMap.get(key) ?? translations[key] ?? string.value
          translations[key] = translatedValue
          allTranslatedStrings.push({ path: string.path, value: translatedValue })
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
            const stringsWithExcluded = excludedKeyValues
              ? [
                  ...allTranslatedStrings,
                  ...Array.from(excludedKeyValues.entries()).map(([path, value]) => ({
                    path,
                    value,
                  })),
                ]
              : allTranslatedStrings
            const translatedContent = await reconstructJS(freshAST, stringsWithExcluded)
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
      return {
        totalJobs: allGroups.length,
        reusedJobs: allGroups.length,
        items: [
        {
          label: `${relativePath} restore`,
          translates: false,
          execute: async () => ({
            filePath,
            write: async () => {
              const freshAST = await parseJS(content, isTypeScript)
              const stringsWithExcluded = excludedKeyValues
                ? [
                    ...allTranslatedStrings,
                    ...Array.from(excludedKeyValues.entries()).map(([path, value]) => ({
                      path,
                      value,
                    })),
                  ]
                : allTranslatedStrings
              const translatedContent = await reconstructJS(freshAST, stringsWithExcluded)
              await writeOutput(config, filePath, translatedContent, targetLang)
              stateStore.set(relativePath, {
                fileHash: sourceFileHash,
                format: 'js',
                groups: nextGroupStates,
              })
            },
          }),
        },
        ],
      }
    }

    return { items: [], totalJobs: allGroups.length, reusedJobs: allGroups.length }
  }

  return {
    items: workItems,
    totalJobs: allGroups.length,
    reusedJobs: allGroups.length - workItems.length,
  }
}

function createUniqueJSTranslationKeys(
  strings: TranslatableJSString[],
): Array<{ key: string; string: TranslatableJSString }> {
  const occurrences = new Map<string, number>()
  const usedKeys = new Set<string>()

  return strings.map((string) => {
    const baseKey = string.objectPath.join('.') || string.path
    let occurrence = (occurrences.get(baseKey) ?? 0) + 1
    let key = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`

    while (usedKeys.has(key)) {
      occurrence++
      key = `${baseKey}#${occurrence}`
    }

    occurrences.set(baseKey, occurrence)
    usedKeys.add(key)
    return { key, string }
  })
}

function getFileGroupStateId(groupKey: string, keys: string[]): string {
  return `${groupKey}::${keys.join('|')}`
}

function getMarkdownChunkStateId(index: number): string {
  return `chunk_${index}`
}

async function initFiles(config: FileTranslateConfig, allFiles: string[]) {
  const languageResults = await Promise.allSettled(
    config.targetLangs.map(async (targetLang) => {
      const stateStore = new FileStateStore(getFileStateRoot(), targetLang)
      await stateStore.load()

      const tasks = allFiles.map(async (filePath) => {
        const relativePath = relative(config.files.sourceDir, filePath)
        const ext = extname(filePath)
        const targetPath = getTargetPath(config, filePath, targetLang)

        if (!existsSync(targetPath)) return

        const content = await readFile(filePath, 'utf-8')
        const sourceFileHash = createContentHash(content)
        const targetContent = await readFile(targetPath, 'utf-8')

        if (ext === '.json') {
          await initJSONFile(
            relativePath,
            content,
            targetContent,
            sourceFileHash,
            config,
            stateStore,
          )
        } else if (ext === '.js' || ext === '.ts') {
          await initJSFile(
            relativePath,
            content,
            targetContent,
            sourceFileHash,
            ext === '.ts',
            config,
            stateStore,
          )
        } else if (ext === '.md') {
          await initMarkdownFile(
            relativePath,
            content,
            targetContent,
            sourceFileHash,
            config,
            stateStore,
          )
        }
      })

      await Promise.all(tasks)
      await stateStore.save()
    }),
  )

  const errors = settledErrors(languageResults)
  if (errors.length > 0) throw new AggregateError(errors, formatAggregateError(errors))
}

async function initJSONFile(
  relativePath: string,
  sourceContent: string,
  targetContent: string,
  sourceFileHash: string,
  config: FileTranslateConfig,
  stateStore: FileStateStore,
) {
  const jsonData = await parseJSON(sourceContent)
  const targetJSON = await parseJSON(targetContent)
  const groups = await extractTranslatableGroups(jsonData, config.files.excludeKeys)

  const splitGroups: SplitGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroups(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])
  const nextGroupStates: Record<string, StoredFileGroupState> = {}

  for (const group of allGroups) {
    const sourceStrings: HashEntry[] = group.strings.map((str) => ({
      key: str.path.join('.'),
      value: str.value,
    }))
    const groupId = getFileGroupStateId(
      group.groupKey,
      sourceStrings.map((str) => str.key),
    )
    const hashMetadata = createHashMetadata(sourceStrings, config.sourceLang)

    const translations: Record<string, string> = {}
    for (const str of group.strings) {
      const key = str.path.join('.')
      let targetValue = getNestedValue(targetJSON, str.path)
      translations[key] = targetValue ?? str.value
    }

    nextGroupStates[groupId] = {
      rowHash: hashMetadata.rowHash,
      fieldHashes: hashMetadata.fieldHashes,
      translations,
    }
  }

  stateStore.set(relativePath, {
    fileHash: sourceFileHash,
    format: 'json',
    groups: nextGroupStates,
  })
}

function getNestedValue(obj: TranslatableJSON, path: string[]): string | undefined {
  let current: TranslatableJSON | string = obj
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as TranslatableJSON)[key]!
    if (current === undefined) return undefined
  }
  return typeof current === 'string' ? current : undefined
}

async function initJSFile(
  relativePath: string,
  sourceContent: string,
  targetContent: string,
  sourceFileHash: string,
  isTypeScript: boolean,
  config: FileTranslateConfig,
  stateStore: FileStateStore,
) {
  const sourceAST = await parseJS(sourceContent, isTypeScript)
  const targetAST = await parseJS(targetContent, isTypeScript)
  const groups = await extractTranslatableGroupsJS(sourceAST, config.files.excludeKeys)
  const targetStrings = await extractTranslatableStringsJS(targetAST)
  const targetMap = new Map(targetStrings.map((s) => [s.path, s.value]))

  const splitGroups: SplitJSGroup[] = config.files.maxStringsPerGroup
    ? splitLargeGroupsJS(groups, config.files.maxStringsPerGroup)
    : groups.map((group) => ({ group }))

  const allGroups = splitGroups.flatMap((sg) => sg.subgroups || [sg.group])
  const nextGroupStates: Record<string, StoredFileGroupState> = {}

  for (const group of allGroups) {
    const keyedStrings = createUniqueJSTranslationKeys(group.strings)
    const sourceStrings: HashEntry[] = keyedStrings.map(({ key, string }) => ({
      key,
      value: string.value,
    }))
    const groupId = getFileGroupStateId(
      group.groupKey,
      sourceStrings.map((str) => str.key),
    )
    const hashMetadata = createHashMetadata(sourceStrings, config.sourceLang)

    const translations: Record<string, string> = {}
    for (const { key, string } of keyedStrings) {
      translations[key] = targetMap.get(string.path) ?? string.value
    }

    nextGroupStates[groupId] = {
      rowHash: hashMetadata.rowHash,
      fieldHashes: hashMetadata.fieldHashes,
      translations,
    }
  }

  stateStore.set(relativePath, {
    fileHash: sourceFileHash,
    format: 'js',
    groups: nextGroupStates,
  })
}

async function initMarkdownFile(
  relativePath: string,
  sourceContent: string,
  targetContent: string,
  sourceFileHash: string,
  config: FileTranslateConfig,
  stateStore: FileStateStore,
) {
  const tree = await parseMarkdown(sourceContent)
  const chunks = await getTranslatableChunks(tree)
  if (chunks.length === 0) return

  const targetTree = await parseMarkdown(targetContent)
  const targetChunks = await getTranslatableChunks(targetTree)

  const nextChunkStates: Record<string, StoredMarkdownChunkState> = {}

  for (const [index, chunk] of chunks.entries()) {
    const chunkId = getMarkdownChunkStateId(index)
    const hashMetadata = createHashMetadata(
      [{ key: 'text', value: chunk.text }],
      config.sourceLang,
    )
    const targetText = targetChunks[index]?.text ?? chunk.text

    nextChunkStates[chunkId] = {
      rowHash: hashMetadata.rowHash,
      translatedText: targetText,
    }
  }

  stateStore.set(relativePath, {
    fileHash: sourceFileHash,
    format: 'md',
    chunks: nextChunkStates,
  })
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
