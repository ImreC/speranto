import { describe, it, expect } from 'vitest'
import { parseMarkdown, getTranslatableChunks } from '../src/parsers/md'

describe('parser', () => {
  it('should create chunks from markdown', async () => {
    const markdown = `# Title

First paragraph.

## Section

List intro:
- Item 1
- Item 2

Conclusion.`

    const tree = await parseMarkdown(markdown)
    const chunks = await getTranslatableChunks(tree)

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.nodes.length).toBeGreaterThan(0)
  })

  it('should group lists with surrounding context', async () => {
    const markdown = `Intro paragraph.

- List item 1
- List item 2

> Quote after list`

    const tree = await parseMarkdown(markdown)
    const chunks = await getTranslatableChunks(tree)

    const listChunk = chunks.find((c) => c.context === 'list-with-context')
    expect(listChunk).toBeDefined()
    expect(listChunk?.nodes.some((n) => n.type === 'paragraph')).toBe(true)
    expect(listChunk?.nodes.some((n) => n.type === 'list')).toBe(true)
    expect(listChunk?.nodes.some((n) => n.type === 'blockquote')).toBe(true)
  })
})
