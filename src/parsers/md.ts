import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root, Heading, BlockContent } from 'mdast'

export const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkStringify)

export async function parseMarkdown(content: string): Promise<Root> {
  const tree = parser.parse(content)
  return tree as Root
}

export async function stringifyMarkdown(tree: Root): Promise<string> {
  const result = parser.stringify(tree)
  return result
}

export interface TranslatableChunk {
  nodes: BlockContent[]
  startIndex: number
  endIndex: number
  context?: string // e.g., "section", "list-with-context", "frontmatter"
  text: string // Markdown string representation of the chunk
}

export async function getTranslatableChunks(tree: Root): Promise<TranslatableChunk[]> {
  const chunks: TranslatableChunk[] = []
  let currentChunk: BlockContent[] = []
  let chunkStartIndex = 0

  // Helper to finalize current chunk
  const finalizeChunk = async (endIndex: number, context?: string) => {
    if (currentChunk.length > 0) {
      // Create a temporary root with just the chunk nodes
      const chunkRoot: Root = {
        type: 'root',
        children: [...currentChunk] as BlockContent[],
      }
      // Convert to markdown string
      const text = await stringifyMarkdown(chunkRoot)

      chunks.push({
        nodes: [...currentChunk],
        startIndex: chunkStartIndex,
        endIndex,
        context,
        text: text.trim(),
      })
      currentChunk = []
    }
  }

  // Track which nodes have been processed
  const processedIndices = new Set<number>()

  // Check for frontmatter at the beginning
  if (
    tree.children.length > 0 &&
    tree.children[0] &&
    (tree.children[0] as any).type === 'yaml'
  ) {
    const frontmatterNode = tree.children[0]
    const frontmatterRoot: Root = {
      type: 'root',
      children: [frontmatterNode as BlockContent],
    }
    const frontmatterText = await stringifyMarkdown(frontmatterRoot)

    chunks.push({
      nodes: [frontmatterNode as BlockContent],
      startIndex: 0,
      endIndex: 0,
      context: 'frontmatter',
      text: frontmatterText.trim(),
    })

    processedIndices.add(0)
    chunkStartIndex = 1
  }

  // Process nodes with context-aware grouping
  for (let index = 0; index < tree.children.length; index++) {
    const node = tree.children[index]
    // Skip if already processed
    if (processedIndices.has(index)) {
      continue
    }

    // Check if this is a heading - potential section boundary
    if (node && node.type === 'heading') {
      const heading = node as Heading

      // For H1 and H2, create section boundaries
      if (heading.depth <= 2 && currentChunk.length > 0) {
        await finalizeChunk(index - 1, 'section')
        chunkStartIndex = index
      }

      currentChunk.push(node)
    }
    // Check if this is a list
    else if (node && node.type === 'list') {
      // Lists should include surrounding context
      // If previous node is a paragraph, include it in the chunk
      if (currentChunk.length === 0 && index > 0) {
        const prevNode = tree.children[index - 1]
        if (prevNode && prevNode.type === 'paragraph' && !processedIndices.has(index - 1)) {
          currentChunk.push(prevNode)
          processedIndices.add(index - 1)
          if (chunkStartIndex > index - 1) {
            chunkStartIndex = index - 1
          }
        }
      }

      currentChunk.push(node)

      // Look ahead - if next node is a paragraph or blockquote, include it
      if (index < tree.children.length - 1) {
        const nextNode = tree.children[index + 1]
        if (nextNode && (nextNode.type === 'paragraph' || nextNode.type === 'blockquote')) {
          currentChunk.push(nextNode)
          processedIndices.add(index + 1)
          await finalizeChunk(index + 1, 'list-with-context')
          chunkStartIndex = index + 2
        } else {
          // Otherwise finalize after the list
          await finalizeChunk(index, 'list')
          chunkStartIndex = index + 1
        }
      } else {
        // Finalize if this is the last node
        await finalizeChunk(index, 'list')
        chunkStartIndex = index + 1
      }
    }
    // Blockquotes often contain important context
    else if (node && node.type === 'blockquote') {
      // If already part of a chunk, don't create a separate one
      if (currentChunk.length > 0) {
        // Already added to chunk, just continue
        continue
      }

      // Include previous paragraph if exists
      if (index > 0) {
        const prevNode = tree.children[index - 1]
        if (prevNode && prevNode.type === 'paragraph' && !processedIndices.has(index - 1)) {
          currentChunk.push(prevNode)
          processedIndices.add(index - 1)
          chunkStartIndex = index - 1
        }
      }

      currentChunk.push(node)
      await finalizeChunk(index, 'blockquote')
      chunkStartIndex = index + 1
    }
    // Code blocks should be isolated
    else if (node && node.type === 'code') {
      await finalizeChunk(index - 1, 'text')
      // Create markdown for code block
      const codeRoot: Root = {
        type: 'root',
        children: [node as BlockContent],
      }
      const codeText = await stringifyMarkdown(codeRoot)
      chunks.push({
        nodes: [node],
        startIndex: index,
        endIndex: index,
        context: 'code',
        text: codeText.trim(),
      })
      chunkStartIndex = index + 1
    }
    // Regular content nodes
    else if (node) {
      currentChunk.push(node as BlockContent)

      // Check if we should create a chunk based on size
      // Estimate: 3-5 paragraphs or similar nodes make a good chunk
      const contentNodeCount = currentChunk.filter(
        (n) => n && (n.type === 'paragraph' || n.type === 'heading' || n.type === 'list'),
      ).length

      if (contentNodeCount >= 4) {
        await finalizeChunk(index, 'text')
        chunkStartIndex = index + 1
      }
    }
  }

  // Finalize any remaining chunk
  if (currentChunk.length > 0) {
    await finalizeChunk(tree.children.length - 1, 'text')
  }
  return chunks
}
