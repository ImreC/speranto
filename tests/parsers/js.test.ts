import { test, expect } from 'bun:test'
import { parseJS, extractTranslatableStringsJS, reconstructJS } from '../../src/parsers/js'

test('parseJS should parse JavaScript code', async () => {
  const content = `const config = { title: "Hello", description: "Welcome" };`
  const ast = await parseJS(content)

  expect(ast.type).toBe('File')
  expect(ast.program.body).toHaveLength(1)
})

test('parseJS should parse TypeScript code', async () => {
  const content = `const config: { title: string } = { title: "Hello" };`
  const ast = await parseJS(content, true)

  expect(ast.type).toBe('File')
  expect(ast.program.body).toHaveLength(1)
})

test('extractTranslatableStringsJS should extract string literals from object properties', async () => {
  const content = `
    const config = {
      title: "Hello World",
      description: "Welcome to our app",
      nested: {
        message: "Nested message"
      }
    };
  `

  const ast = await parseJS(content)
  const strings = await extractTranslatableStringsJS(ast)

  expect(strings).toHaveLength(3)
  expect(strings[0]).toMatchObject({ value: 'Hello World' })
  expect(strings[1]).toMatchObject({ value: 'Welcome to our app' })
  expect(strings[2]).toMatchObject({ value: 'Nested message' })
})

test('extractTranslatableStringsJS should extract template literals without expressions', async () => {
  const content = `
    const config = {
      title: \`Hello World\`,
      dynamic: \`Hello \${name}\`,
      static: \`Static template\`
    };
  `

  const ast = await parseJS(content)
  const strings = await extractTranslatableStringsJS(ast)

  expect(strings).toHaveLength(2)
  expect(strings[0]).toMatchObject({ value: 'Hello World' })
  expect(strings[1]).toMatchObject({ value: 'Static template' })
})

test('reconstructJS should replace string values with translations', async () => {
  const content = `
const config = {
  title: "Hello",
  description: "Welcome"
};`

  const ast = await parseJS(content)
  const translations = [
    { path: 'string_0', value: 'Hola' },
    { path: 'string_1', value: 'Bienvenido' },
  ]

  const result = await reconstructJS(ast, translations)

  expect(result).toContain('"Hola"')
  expect(result).toContain('"Bienvenido"')
})

test('reconstructJS should replace template literal values', async () => {
  const content = `
const config = {
  title: \`Hello World\`,
  message: \`Welcome\`
};`

  const ast = await parseJS(content)
  const translations = [
    { path: 'template_0', value: 'Hola Mundo' },
    { path: 'template_1', value: 'Bienvenido' },
  ]

  const result = await reconstructJS(ast, translations)

  expect(result).toContain('`Hola Mundo`')
  expect(result).toContain('`Bienvenido`')
})
