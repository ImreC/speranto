import { glob } from 'glob'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative, extname } from 'path'
import { getTranslatableChunks, parseMarkdown, stringifyMarkdown } from './parsers/md'
import {
  parseJSON,
  stringifyJSON,
  extractTranslatableGroups,
  reconstructJSON,
} from './parsers/json'
import { parseJS, extractTranslatableGroupsJS, reconstructJS } from './parsers/js'
import { Translator } from './translator'
// import { visit } from 'unist-util-visit'
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

  console.log(`Found ${files.length} file${files.length !== 1 ? 's' : ''} to translate`)

  for (const targetLang of config.targetLangs) {
    console.log(`Translating to ${targetLang}...`)

    const translator = new Translator({
      model: config.model,
      temperature: config.temperature,
      sourceLang: config.sourceLang,
      targetLang: targetLang,
      provider: config.provider,
      apiKey: config.apiKey,
      llm: config.llm,
    })

    for (const file of files) {
      const ext = extname(file)
      if (ext === '.md') {
        await translateMarkdownFile(file, config, targetLang, translator)
      } else if (ext === '.json') {
        await translateJSONFile(file, config, targetLang, translator)
      } else if (ext === '.js' || ext === '.ts') {
        await translateJSFile(file, config, targetLang, translator, ext === '.ts')
      }
    }
  }

  console.log('Translation complete!')
}

async function writeOutput(
  config: Config,
  filePath: string,
  translatedContent: string,
  targetLang: string,
) {
  const relativePath = relative(config.sourceDir, filePath)
  let targetPath: string
  if (config.useLangCodeAsFilename) {
    const ext = extname(filePath)
    const dirPath = dirname(relativePath)
    targetPath = join(
      config.targetDir.replace('[lang]', targetLang),
      dirPath,
      `${targetLang}${ext}`,
    )
  } else {
    targetPath = join(config.targetDir.replace('[lang]', targetLang), relativePath)
  }
  console.log(`Saving result in targetPath: ${targetPath}`)

  await mkdir(dirname(targetPath), { recursive: true })

  await writeFile(targetPath, translatedContent, 'utf-8')

  return relativePath
}

async function translateMarkdownFile(
  filePath: string,
  config: Config,
  targetLang: string,
  translator: Translator,
) {
  try {
    // Read source file
    console.log(`Reading source file ${filePath}`)
    const content = await readFile(filePath, 'utf-8')

    // Parse markdown
    const tree = await parseMarkdown(content)
    const chunks = await getTranslatableChunks(tree)

    console.log(`Created ${chunks.length} chunks`)

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

    const relativePath = await writeOutput(config, filePath, translatedContent, targetLang)
    console.log(`Translated ${relativePath} -> ${targetLang}`)
  } catch (error) {
    console.error(`Error translating ${filePath}:`, error)
  }
}

async function translateJSONFile(
  filePath: string,
  config: Config,
  targetLang: string,
  translator: Translator,
) {
  try {
    console.log(`Reading JSON file ${filePath}`)
    const content = await readFile(filePath, 'utf-8')

    const jsonData = await parseJSON(content)
    const groups = await extractTranslatableGroups(jsonData)

    const totalStrings = groups.reduce((sum, g) => sum + g.strings.length, 0)
    console.log(`Found ${totalStrings} strings in ${groups.length} groups to translate`)

    const allTranslatedStrings: Array<{ path: string[]; value: string }> = []

    for (const group of groups) {
      const groupStrings = group.strings.map(({ path, value }) => ({
        key: path.join('.'),
        value,
      }))

      const translatedGroupStrings = await translator.translateGroup(group.groupKey, groupStrings)

      for (let i = 0; i < group.strings.length; i++) {
        const original = group.strings[i]!
        const translated = translatedGroupStrings[i]!
        allTranslatedStrings.push({
          path: original.path,
          value: translated.value,
        })
      }
    }

    const translatedJSON = await reconstructJSON(jsonData, allTranslatedStrings)
    const translatedContent = await stringifyJSON(translatedJSON)

    const relativePath = await writeOutput(config, filePath, translatedContent, targetLang)
    console.log(`Translated ${relativePath} -> ${targetLang}`)
  } catch (error) {
    console.error(`Error translating ${filePath}:`, error)
  }
}

async function translateJSFile(
  filePath: string,
  config: Config,
  targetLang: string,
  translator: Translator,
  isTypeScript: boolean,
) {
  try {
    console.log(`Reading JS/TS file ${filePath}`)
    const content = await readFile(filePath, 'utf-8')

    const ast = await parseJS(content, isTypeScript)
    const groups = await extractTranslatableGroupsJS(ast)

    const totalStrings = groups.reduce((sum, g) => sum + g.strings.length, 0)
    console.log(`Found ${totalStrings} strings in ${groups.length} groups to translate`)

    const allTranslatedStrings: Array<{ path: string; value: string }> = []

    for (const group of groups) {
      const groupStrings = group.strings.map(({ path, objectPath, value }) => ({
        key: objectPath.length > 0 ? objectPath.join('.') : path,
        value,
      }))

      const translatedGroupStrings = await translator.translateGroup(group.groupKey, groupStrings)

      for (let i = 0; i < group.strings.length; i++) {
        const original = group.strings[i]!
        const translated = translatedGroupStrings[i]!
        allTranslatedStrings.push({
          path: original.path,
          value: translated.value,
        })
      }
    }

    const translatedContent = await reconstructJS(ast, allTranslatedStrings)

    const relativePath = await writeOutput(config, filePath, translatedContent, targetLang)

    console.log(`Translated ${relativePath} -> ${targetLang}`)
  } catch (error) {
    console.error(`Error translating ${filePath}:`, error)
  }
}
