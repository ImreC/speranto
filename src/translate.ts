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
import { parseJS, extractTranslatableGroupsJS, reconstructJS, type TranslatableJSGroup } from './parsers/js'
import { Translator } from './translator'
import type { Config } from './types'
import type { Root, BlockContent } from 'mdast'

export async function translate(config: Config) {
  let patterns: string[]

  if (config.useLangCodeAsFilename) {
    patterns = [
      join(config.sourceDir, `**/${config.sourceLang}.md`),
      join(config.sourceDir, `**/${config.sourceLang}.json`),
      join(config.sourceDir, `**/${config.sourceLang}.js`),
      join(config.sourceDir, `**/${config.sourceLang}.ts`),
    ]
  } else {
    patterns = [
      join(config.sourceDir, '**/*.md'),
      join(config.sourceDir, '**/*.json'),
      join(config.sourceDir, '**/*.js'),
      join(config.sourceDir, '**/*.ts'),
    ]
  }

  const allFiles = await Promise.all(patterns.map((pattern) => glob(pattern)))
  const files = allFiles.flat()

  if (files.length === 0) {
    console.log('No files found to translate.')
    return
  }

  console.log(`Using ${config.provider || 'ollama'} provider`)

  const translators = new Map<string, Translator>()
  for (const targetLang of config.targetLangs) {
    translators.set(
      targetLang,
      new Translator({
        model: config.model,
        temperature: config.temperature,
        sourceLang: config.sourceLang,
        targetLang: targetLang,
        provider: config.provider,
        apiKey: config.apiKey,
        llm: config.llm,
      }),
    )
  }

  const tasks = new Listr(
    files.map((file) => {
      const ext = extname(file)
      const relativePath = relative(config.sourceDir, file)

      return {
        title: relativePath,
        task: (_ctx, task) =>
          task.newListr(
            config.targetLangs.map((targetLang) => ({
              title: targetLang,
              task: async (_ctx, langTask) => {
                const translator = translators.get(targetLang)!
                if (ext === '.md') {
                  return translateMarkdownFile(file, config, targetLang, translator, langTask)
                } else if (ext === '.json') {
                  return translateJSONFile(file, config, targetLang, translator, langTask)
                } else if (ext === '.js' || ext === '.ts') {
                  return translateJSFile(file, config, targetLang, translator, ext === '.ts', langTask)
                }
              },
            })),
            { concurrent: true },
          ),
      }
    }),
    { concurrent: false },
  )

  await tasks.run()
}

function getTargetPath(config: Config, filePath: string, targetLang: string): string {
  const relativePath = relative(config.sourceDir, filePath)
  if (config.useLangCodeAsFilename) {
    const ext = extname(filePath)
    const dirPath = dirname(relativePath)
    return join(config.targetDir.replace('[lang]', targetLang), dirPath, `${targetLang}${ext}`)
  } else {
    return join(config.targetDir.replace('[lang]', targetLang), relativePath)
  }
}

async function writeOutput(
  config: Config,
  filePath: string,
  translatedContent: string,
  targetLang: string,
) {
  const targetPath = getTargetPath(config, filePath, targetLang)

  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, translatedContent, 'utf-8')

  return relative(config.sourceDir, filePath)
}

async function translateMarkdownFile(
  filePath: string,
  config: Config,
  targetLang: string,
  translator: Translator,
  task: any,
) {
  const content = await readFile(filePath, 'utf-8')
  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)
  const relativePath = relative(config.sourceDir, filePath)

  task.title = `${relativePath} (${chunks.length} chunks)`

  const translatedTree: Root = JSON.parse(JSON.stringify(tree))

  const translatedChunks = await Promise.all(
    chunks.map(async (chunk) => {
      const translatedText = await translator.translateChunk(chunk)
      return {
        ...chunk,
        text: translatedText,
      }
    }),
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

function hasGroupChanged(
  sourceGroup: TranslatableGroup,
  existingGroups: TranslatableGroup[],
): boolean {
  const existingGroup = existingGroups.find((g) => g.groupKey === sourceGroup.groupKey)
  if (!existingGroup) return true

  if (sourceGroup.strings.length !== existingGroup.strings.length) return true

  for (const sourceString of sourceGroup.strings) {
    const existingString = existingGroup.strings.find(
      (s) => s.path.join('.') === sourceString.path.join('.'),
    )
    if (!existingString) return true
  }

  return false
}

async function translateJSONFile(
  filePath: string,
  config: Config,
  targetLang: string,
  translator: Translator,
  task: any,
) {
  const content = await readFile(filePath, 'utf-8')
  const jsonData = await parseJSON(content)
  const groups = await extractTranslatableGroups(jsonData)

  const targetPath = getTargetPath(config, filePath, targetLang)
  let existingTranslations: Map<string, string> = new Map()
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

  const changedGroups = groups.filter((g) => hasGroupChanged(g, existingGroups))
  const unchangedGroups = groups.filter((g) => !hasGroupChanged(g, existingGroups))

  if (changedGroups.length === 0) {
    task.skip(`${targetLang}: ${groups.length}/${groups.length} groups unchanged`)
    return
  }

  task.title =
    `${targetLang}: translating ${changedGroups.length}/${groups.length} groups` +
    (unchangedGroups.length > 0 ? `, ${unchangedGroups.length}/${groups.length} groups unchanged` : '')

  const allTranslatedStrings: Array<{ path: string[]; value: string }> = []

  for (const group of unchangedGroups) {
    for (const str of group.strings) {
      const existingValue = existingTranslations.get(str.path.join('.'))
      allTranslatedStrings.push({
        path: str.path,
        value: existingValue ?? str.value,
      })
    }
  }

  await Promise.all(
    changedGroups.map(async (group) => {
      const groupStrings = group.strings.map(({ path, value }) => ({
        key: path.join('.'),
        value,
      }))

      const translatedGroupStrings = await translator.translateGroup(group.groupKey, groupStrings)

      for (let i = 0; i < group.strings.length; i++) {
        allTranslatedStrings.push({
          path: group.strings[i]!.path,
          value: translatedGroupStrings[i]!.value,
        })
      }
    }),
  )

  const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
  const translatedContent = await stringifyJSON(translatedJSON)
  await writeOutput(config, filePath, translatedContent, targetLang)
}

function hasJSGroupChanged(
  sourceGroup: TranslatableJSGroup,
  existingGroups: TranslatableJSGroup[],
): boolean {
  const existingGroup = existingGroups.find((g) => g.groupKey === sourceGroup.groupKey)
  if (!existingGroup) return true

  if (sourceGroup.strings.length !== existingGroup.strings.length) return true

  for (const sourceString of sourceGroup.strings) {
    const sourceKey = sourceString.objectPath.join('.') || sourceString.path
    const existingString = existingGroup.strings.find((s) => {
      const existingKey = s.objectPath.join('.') || s.path
      return existingKey === sourceKey
    })
    if (!existingString) return true
  }

  return false
}

async function translateJSFile(
  filePath: string,
  config: Config,
  targetLang: string,
  translator: Translator,
  isTypeScript: boolean,
  task: any,
) {
  const content = await readFile(filePath, 'utf-8')
  const ast = await parseJS(content, isTypeScript)
  const groups = await extractTranslatableGroupsJS(ast)

  const targetPath = getTargetPath(config, filePath, targetLang)
  let existingTranslations: Map<string, string> = new Map()
  let existingGroups: TranslatableJSGroup[] = []

  if (existsSync(targetPath)) {
    try {
      const existingContent = await readFile(targetPath, 'utf-8')
      const existingAST = await parseJS(existingContent, isTypeScript)
      existingGroups = await extractTranslatableGroupsJS(existingAST)

      for (const group of existingGroups) {
        for (const str of group.strings) {
          const key = str.objectPath.join('.') || str.path
          existingTranslations.set(key, str.value)
        }
      }
    } catch {
      // Could not parse existing, will retranslate all
    }
  }

  const changedGroups = groups.filter((g) => hasJSGroupChanged(g, existingGroups))
  const unchangedGroups = groups.filter((g) => !hasJSGroupChanged(g, existingGroups))

  if (changedGroups.length === 0) {
    task.skip(`${targetLang}: ${groups.length}/${groups.length} groups unchanged`)
    return
  }

  task.title =
    `${targetLang}: translating ${changedGroups.length}/${groups.length} groups` +
    (unchangedGroups.length > 0 ? `, ${unchangedGroups.length}/${groups.length} groups unchanged` : '')

  const allTranslatedStrings: Array<{ path: string; value: string }> = []

  for (const group of unchangedGroups) {
    for (const str of group.strings) {
      const key = str.objectPath.join('.') || str.path
      const existingValue = existingTranslations.get(key)
      allTranslatedStrings.push({
        path: str.path,
        value: existingValue ?? str.value,
      })
    }
  }

  await Promise.all(
    changedGroups.map(async (group) => {
      const groupStrings = group.strings.map(({ path, objectPath, value }) => ({
        key: objectPath.length > 0 ? objectPath.join('.') : path,
        value,
      }))

      const translatedGroupStrings = await translator.translateGroup(group.groupKey, groupStrings)

      for (let i = 0; i < group.strings.length; i++) {
        allTranslatedStrings.push({
          path: group.strings[i]!.path,
          value: translatedGroupStrings[i]!.value,
        })
      }
    }),
  )

  const translatedContent = await reconstructJS(ast, allTranslatedStrings)
  await writeOutput(config, filePath, translatedContent, targetLang)
}
