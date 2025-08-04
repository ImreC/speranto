import { parse } from '@babel/parser'
const generate = require('@babel/generator').default
const traverse = require('@babel/traverse').default
import * as t from '@babel/types'

export interface TranslatableJSString {
  path: string
  value: string
  loc?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

export async function parseJS(content: string, isTypeScript: boolean = false): Promise<any> {
  return parse(content, {
    sourceType: 'module',
    plugins: isTypeScript ? ['typescript'] : [],
  })
}

export async function extractTranslatableStringsJS(
  ast: any
): Promise<TranslatableJSString[]> {
  const results: TranslatableJSString[] = []
  let nodeCounter = 0

  traverse(ast, {
    StringLiteral(path) {
      // Check if the string is in an object property value position
      if (
        path.parent.type === 'ObjectProperty' &&
        path.parent.value === path.node &&
        !isVariableReference(path)
      ) {
        results.push({
          path: `string_${nodeCounter++}`,
          value: path.node.value,
          loc: path.node.loc || undefined,
        })
      }
    },
    TemplateLiteral(path) {
      // Skip template literals with expressions (like ${SITE_TITLE})
      if (path.node.expressions.length > 0) {
        return
      }
      
      // Check if it's in an object property value position
      if (
        path.parent.type === 'ObjectProperty' &&
        path.parent.value === path.node
      ) {
        const value = path.node.quasis[0].value.raw
        results.push({
          path: `template_${nodeCounter++}`,
          value,
          loc: path.node.loc || undefined,
        })
      }
    },
  })

  return results
}

function isVariableReference(path: any): boolean {
  // Skip any value that references a variable or constant
  // This includes imported constants like SITE_TITLE
  return false
}

function containsVariableReferences(node: any): boolean {
  // Check if template literal contains ${} expressions
  return node.expressions && node.expressions.length > 0
}

export async function reconstructJS(
  ast: any,
  translations: Array<{ path: string; value: string }>
): Promise<string> {
  let stringCounter = 0
  let templateCounter = 0
  const translationMap = new Map(translations.map(t => [t.path, t.value]))

  traverse(ast, {
    StringLiteral(path) {
      if (
        path.parent.type === 'ObjectProperty' &&
        path.parent.value === path.node &&
        !isVariableReference(path)
      ) {
        const key = `string_${stringCounter++}`
        if (translationMap.has(key)) {
          path.node.value = translationMap.get(key)!
        }
      }
    },
    TemplateLiteral(path) {
      // Skip template literals with expressions
      if (path.node.expressions.length > 0) {
        return
      }
      
      if (
        path.parent.type === 'ObjectProperty' &&
        path.parent.value === path.node
      ) {
        const key = `template_${templateCounter++}`
        if (translationMap.has(key)) {
          path.node.quasis[0].value.raw = translationMap.get(key)!
          path.node.quasis[0].value.cooked = translationMap.get(key)!
        }
      }
    },
  })

  const generated = generate(ast, {}, '')
  return generated.code
}