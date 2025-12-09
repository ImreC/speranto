import { test, expect } from 'bun:test'
import { parseJS, extractTranslatableStringsJS, extractTranslatableGroupsJS, reconstructJS } from '../../src/parsers/js'

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

test('extractTranslatableGroupsJS should group nested objects', async () => {
  const content = `
    export default {
      siteTitle: "My Site",
      nav: {
        home: "Home",
        blog: "Blog",
        about: "About"
      },
      footer: {
        copyright: "Copyright 2024",
        contact: "Contact Us"
      }
    };
  `

  const ast = await parseJS(content)
  const groups = await extractTranslatableGroupsJS(ast)

  expect(groups).toHaveLength(3)

  const rootGroup = groups.find(g => g.groupKey === '_root')
  expect(rootGroup).toBeDefined()
  expect(rootGroup!.strings).toHaveLength(1)

  const navGroup = groups.find(g => g.groupKey === 'nav')
  expect(navGroup).toBeDefined()
  expect(navGroup!.strings).toHaveLength(3)
  expect(navGroup!.strings.map(s => s.value)).toContain('Home')

  const footerGroup = groups.find(g => g.groupKey === 'footer')
  expect(footerGroup).toBeDefined()
  expect(footerGroup!.strings).toHaveLength(2)
})

test('extractTranslatableStringsJS should include objectPath for nested properties', async () => {
  const content = `
    const config = {
      nav: {
        home: "Home",
        blog: "Blog"
      }
    };
  `

  const ast = await parseJS(content)
  const strings = await extractTranslatableStringsJS(ast)

  expect(strings).toHaveLength(2)
  expect(strings[0]!.objectPath).toEqual(['nav', 'home'])
  expect(strings[1]!.objectPath).toEqual(['nav', 'blog'])
})
