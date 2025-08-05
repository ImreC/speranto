import { test, expect } from 'bun:test'
import {
  parseJSON,
  stringifyJSON,
  extractTranslatableStrings,
  reconstructJSON,
} from '../../src/parsers/json'

test('parseJSON should parse valid JSON', async () => {
  const content = '{"greeting": "Hello", "nested": {"farewell": "Goodbye"}}'
  const result = await parseJSON(content)

  expect(result).toEqual({
    greeting: 'Hello',
    nested: {
      farewell: 'Goodbye',
    },
  })
})

test('parseJSON should throw on invalid JSON', async () => {
  const content = '{"greeting": "Hello",}'

  expect(async () => await parseJSON(content)).toThrow()
})

test('stringifyJSON should format JSON with 2-space indentation', async () => {
  const data = {
    greeting: 'Hello',
    nested: {
      farewell: 'Goodbye',
    },
  }

  const result = await stringifyJSON(data)
  const expected = `{
  "greeting": "Hello",
  "nested": {
    "farewell": "Goodbye"
  }
}`

  expect(result).toBe(expected)
})

test('extractTranslatableStrings should extract all string values with paths', async () => {
  const obj = {
    greeting: 'Hello',
    nested: {
      farewell: 'Goodbye',
      deeper: {
        message: 'Welcome',
      },
    },
  }

  const result = await extractTranslatableStrings(obj)

  expect(result).toEqual([
    { path: ['greeting'], value: 'Hello' },
    { path: ['nested', 'farewell'], value: 'Goodbye' },
    { path: ['nested', 'deeper', 'message'], value: 'Welcome' },
  ])
})

test('reconstructJSON should rebuild object with translated values', async () => {
  const original = {
    greeting: 'Hello',
    nested: {
      farewell: 'Goodbye',
    },
  }

  const translations = [
    { path: ['greeting'], value: 'Hola' },
    { path: ['nested', 'farewell'], value: 'Adiós' },
  ]

  const result = await reconstructJSON(original, translations)

  expect(result).toEqual({
    greeting: 'Hola',
    nested: {
      farewell: 'Adiós',
    },
  })
})

test('reconstructJSON should preserve structure with partial translations', async () => {
  const original = {
    greeting: 'Hello',
    nested: {
      farewell: 'Goodbye',
    },
  }

  const translations = [
    { path: ['greeting'], value: 'Hola' },
    { path: ['nested', 'farewell'], value: 'Adiós' },
  ]

  const result = await reconstructJSON(original, translations)

  expect(result).toEqual({
    greeting: 'Hola',
    nested: {
      farewell: 'Adiós',
    },
  })
})
