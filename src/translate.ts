import { glob } from 'glob'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative } from 'path'
import {
  getTranslatableChunks,
  parseMarkdown,
  stringifyMarkdown,
  type TranslatableChunk,
} from './parser'
import { Translator } from './translator'
// import { visit } from 'unist-util-visit'
import type { Config } from './types'
import type { Root, Text, BlockContent } from 'mdast'

export async function translate(config: Config) {
  const pattern = join(config.sourceDir, '**/*.md')
  const files = await glob(pattern)

  console.log(
    `Found ${files.length} markdown file${files.length !== 1 ? 's' : ''} to translate`,
  )

  for (const targetLang of config.targetLangs) {
    console.log(`Translating to ${targetLang}...`)

    const translator = new Translator({
      model: config.model,
      temperature: config.temperature,
      sourceLang: config.sourceLang,
      targetLang: targetLang,
    })

    for (const file of files) {
      await translateFile(file, config, targetLang, translator)
    }
  }

  console.log('Translation complete!')
}

async function translateFile(
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

    // Create a deep copy of the tree for translation
    const translatedTree: Root = JSON.parse(JSON.stringify(tree))

    // Translate chunks
    const translatedChunks: TranslatableChunk[] = []

    for (const chunk of chunks) {
      const translatedText = await translator.translateChunk(chunk)
      translatedChunks.push({
        ...chunk,
        text: translatedText,
      })
    }

    // Reconstruct the tree with translated content
    for (const translatedChunk of translatedChunks) {
      // Parse the translated text back to nodes
      const translatedNodes = await parseMarkdown(translatedChunk.text)

      // Replace the nodes in the translated tree
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

    // Stringify the translated tree
    let translatedContent = await stringifyMarkdown(translatedTree)

    // Generate output path
    const relativePath = relative(config.sourceDir, filePath)
    const targetPath = join(config.targetDir.replace('[lang]', targetLang), relativePath)
    console.log(`Saving result in targetPath: ${targetPath}`)

    // Ensure target directory exists
    await mkdir(dirname(targetPath), { recursive: true })

    translatedContent += `\n\nTranslated automatically with ${config.model}. The original content was written in ${config.sourceLang}. Please allow for minor errors.`

    // Write the translated markdown
    await writeFile(targetPath, translatedContent, 'utf-8')

    console.log(`Translated ${relativePath} -> ${targetLang}`)
  } catch (error) {
    console.error(`Error translating ${filePath}:`, error)
  }
}
