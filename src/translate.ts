import { glob } from 'glob'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative } from 'path'
// import { parseMarkdown, stringifyMarkdown } from './parser'
import { Translator } from './translator'
// import { visit } from 'unist-util-visit'
import type { Config } from './types'
// import type { Root, Text } from 'mdast'

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

    // // Parse markdown
    // const tree = await parseMarkdown(content)

    // // Create a deep copy of the tree for translation
    // const translatedTree: Root = JSON.parse(JSON.stringify(tree))

    // // Translate all text nodes
    // const promises: Promise<void>[] = []

    // visit(translatedTree, 'text', (node: Text) => {
    //   if (node.value.trim()) {
    //     promises.push(
    //       translator.translateText(node.value).then((translated) => {
    //         node.value = translated
    //       }),
    //     )
    //   }
    // })

    // // Wait for all translations to complete
    // await Promise.all(promises)

    let translatedContent = await translator.translateText(content)
    // Generate output path
    const relativePath = relative(config.sourceDir, filePath)
    const targetPath = join(config.targetDir.replace('[lang]', targetLang), relativePath)
    console.log(`Saving result in targetPath: ${targetPath}`)

    // Ensure target directory exists
    await mkdir(dirname(targetPath), { recursive: true })

    translatedContent += `\n\nTranslated automatically with ${config.model}. The original content was written in ${config.sourceLang}. Please allow for minor errors.`

    // Stringify and write the translated markdown
    // const translatedContent = await stringifyMarkdown(translatedTree)
    await writeFile(targetPath, translatedContent, 'utf-8')

    console.log(`Translated ${relativePath} -> ${targetLang}`)
  } catch (error) {
    console.error(`Error translating ${filePath}:`, error)
  }
}
