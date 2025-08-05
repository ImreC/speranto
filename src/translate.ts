import { glob } from 'glob'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative, extname, basename } from 'path'
import {
  getTranslatableChunks,
  parseMarkdown,
  stringifyMarkdown,
  type TranslatableChunk,
} from './parsers/md'
import {
  parseJSON,
  stringifyJSON,
  extractTranslatableStrings,
  reconstructJSON,
} from './parsers/json'
import { parseJS, extractTranslatableStringsJS, reconstructJS } from './parsers/js'
import { Translator } from './translator'
// import { visit } from 'unist-util-visit'
import type { Config } from './types'
import type { Root, BlockContent } from 'mdast'

export async function translate(config: Config) {
  const patterns = [
    join(config.sourceDir, '**/*.md'),
    join(config.sourceDir, '**/*.json'),
    join(config.sourceDir, '**/*.js'),
    join(config.sourceDir, '**/*.ts'),
  ]

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
    const strings = await extractTranslatableStrings(jsonData)

    console.log(`Found ${strings.length} strings to translate`)

    const translatedStrings = await Promise.all(
      strings.map(async ({ path, value }) => {
        const translatedText = await translator.translateText(value)
        return { path, value: translatedText }
      }),
    )

    const translatedJSON = await reconstructJSON(jsonData, translatedStrings)
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
    const strings = await extractTranslatableStringsJS(ast)

    console.log(`Found ${strings.length} strings to translate`)

    const translatedStrings = await Promise.all(
      strings.map(async ({ path, value }) => {
        const translatedText = await translator.translateText(value)
        return { path, value: translatedText }
      }),
    )

    const translatedContent = await reconstructJS(ast, translatedStrings)

    const relativePath = await writeOutput(config, filePath, translatedContent, targetLang)

    console.log(`Translated ${relativePath} -> ${targetLang}`)
  } catch (error) {
    console.error(`Error translating ${filePath}:`, error)
  }
}
