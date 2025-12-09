import { test, expect } from 'bun:test'
import {
  parseJSON,
  stringifyJSON,
  extractTranslatableStrings,
  extractTranslatableGroups,
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

test('extractTranslatableGroups should group nested objects as separate groups', async () => {
  const obj = {
    siteTitle: 'My Site',
    siteDescription: 'Welcome',
    nav: {
      home: 'Home',
      blog: 'Blog',
      about: 'About',
    },
    footer: {
      copyright: 'Copyright 2024',
      contact: 'Contact Us',
    },
  }

  const groups = await extractTranslatableGroups(obj)

  expect(groups).toHaveLength(3)

  const rootGroup = groups.find(g => g.groupKey === '_ungrouped')
  expect(rootGroup).toBeDefined()
  expect(rootGroup!.strings).toHaveLength(2)

  const navGroup = groups.find(g => g.groupKey === 'nav')
  expect(navGroup).toBeDefined()
  expect(navGroup!.strings).toHaveLength(3)
  expect(navGroup!.strings.map(s => s.value)).toContain('Home')
  expect(navGroup!.strings.map(s => s.value)).toContain('Blog')

  const footerGroup = groups.find(g => g.groupKey === 'footer')
  expect(footerGroup).toBeDefined()
  expect(footerGroup!.strings).toHaveLength(2)
})

test('extractTranslatableGroups should group dot-notation keys', async () => {
  const obj = {
    'pricing.title': 'Pricing Plans',
    'pricing.description': 'Choose your plan',
    'pricing.monthly': 'Monthly',
    'features.title': 'Features',
    'features.list': 'Feature List',
    'standalone': 'Standalone Key',
  }

  const groups = await extractTranslatableGroups(obj)

  expect(groups).toHaveLength(3)

  const pricingGroup = groups.find(g => g.groupKey === 'pricing')
  expect(pricingGroup).toBeDefined()
  expect(pricingGroup!.strings).toHaveLength(3)

  const featuresGroup = groups.find(g => g.groupKey === 'features')
  expect(featuresGroup).toBeDefined()
  expect(featuresGroup!.strings).toHaveLength(2)

  const ungroupedGroup = groups.find(g => g.groupKey === '_ungrouped')
  expect(ungroupedGroup).toBeDefined()
  expect(ungroupedGroup!.strings).toHaveLength(1)
})
