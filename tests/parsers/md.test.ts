import { test, expect } from 'bun:test'
import { parseMarkdown, stringifyMarkdown, getTranslatableChunks } from '../../src/parsers/md'

test('parseMarkdown should parse markdown content', async () => {
  const content = `# Hello World

This is a paragraph.

- Item 1
- Item 2`

  const tree = await parseMarkdown(content)

  expect(tree.type).toBe('root')
  expect(tree.children).toHaveLength(3)
  expect(tree.children[0]?.type).toBe('heading')
  expect(tree.children[1]?.type).toBe('paragraph')
  expect(tree.children[2]?.type).toBe('list')
})

test('stringifyMarkdown should convert AST back to markdown', async () => {
  const content = `# Hello World

This is a paragraph.`

  const tree = await parseMarkdown(content)
  const result = await stringifyMarkdown(tree)

  expect(result.trim()).toBe(content)
})

test('getTranslatableChunks should group content into chunks', async () => {
  const content = `# Main Title

This is the introduction.

## Section One

First paragraph of section one.

Second paragraph of section one.

## Section Two

Content for section two.`

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  expect(chunks.length).toBeGreaterThan(0)
  expect(chunks[0]?.context).toBe('section')
  expect(chunks[0]?.text).toContain('Main Title')
  expect(chunks[0]?.text).toContain('introduction')
})

test('getTranslatableChunks should handle lists with context', async () => {
  const content = `Here are the features:

- Feature one
- Feature two
- Feature three

This explains the features above.`

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.context).toBe('list-with-context')
  expect(chunks[0]?.text).toContain('Here are the features')
  expect(chunks[0]?.text).toContain('Feature one')
  expect(chunks[0]?.text).toContain('This explains the features')
})

test('getTranslatableChunks should isolate code blocks', async () => {
  const content = `Some text before code.

\`\`\`javascript
// This is code
const hello = "world";
\`\`\`

Some text after code.`

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  expect(chunks.length).toBeGreaterThan(1)

  const codeChunk = chunks.find((c) => c.context === 'code')
  expect(codeChunk).toBeDefined()
  expect(codeChunk?.text).toContain('// This is code')
  expect(codeChunk?.text).toContain('const hello = "world"')
})

test('getTranslatableChunks should handle blockquotes', async () => {
  const content = `Here's an important note:

> This is a blockquote with
> multiple lines of text.`

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  // The parser creates chunks - verify we have at least one
  expect(chunks.length).toBeGreaterThan(0)

  // Based on the implementation, blockquotes with preceding paragraphs
  // are grouped together, so we should have one chunk with both
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.text).toContain('important note')
})

test('getTranslatableChunks should create section boundaries at H1 and H2', async () => {
  const content = `# Title One

Content for title one.

## Section Two

Section two content.

# Title Two

Content for title two.`

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  // Check that we have multiple chunks (sections are being created)
  expect(chunks.length).toBeGreaterThan(1)
  // Verify content is properly chunked
  const firstChunk = chunks.find((c) => c.text.includes('Title One'))
  const secondChunk = chunks.find((c) => c.text.includes('Title Two'))
  expect(firstChunk).toBeDefined()
  expect(secondChunk).toBeDefined()
})

test('getTranslatableChunks should handle frontmatter as a separate chunk', async () => {
  const content = `---
title: "Is Europe behind in tech? It's time for a mindset shift"
description: 'Europe seems to be lagging behind in tech, but it doesn't have to be this way.'
pubDate: '2025-07-23'
heroImage: '../../../src/images/blog/europe-behind-in-tech.jpg'
featured: true
lang: en
---

# Main Content

This is the main content after frontmatter.

## Section One

Some content in section one.`

  const tree = await parseMarkdown(content)
  const chunks = await getTranslatableChunks(tree)

  // Check that we have at least 2 chunks (frontmatter + content)
  expect(chunks.length).toBeGreaterThanOrEqual(2)

  // Check that the first chunk is frontmatter
  const frontmatterChunk = chunks[0]
  expect(frontmatterChunk?.context).toBe('frontmatter')
  expect(frontmatterChunk?.startIndex).toBe(0)
  expect(frontmatterChunk?.endIndex).toBe(0)
  expect(frontmatterChunk?.text).toContain('---')
  expect(frontmatterChunk?.text).toContain('title: "Is Europe behind in tech?')
  expect(frontmatterChunk?.text).toContain('lang: en')

  // Check that subsequent chunks don't include frontmatter
  const contentChunks = chunks.slice(1)
  for (const chunk of contentChunks) {
    expect(chunk.text).not.toContain('pubDate:')
    expect(chunk.text).not.toContain('heroImage:')
  }

  // Verify the content is still properly chunked
  const mainContentChunk = chunks.find((c) => c.text.includes('Main Content'))
  expect(mainContentChunk).toBeDefined()
  expect(mainContentChunk?.context).toBe('section')
})
