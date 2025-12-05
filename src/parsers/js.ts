import { parse } from '@babel/parser'
import * as _generate from '@babel/generator'
import * as _traverse from '@babel/traverse'
import * as t from '@babel/types'

function resolveDefault<T>(mod: any): T {
  if (typeof mod === 'function') return mod
  if (mod && typeof mod.default === 'function') return mod.default
  if (mod && mod.default && typeof mod.default.default === 'function') return mod.default.default
  return mod
}

const traverse = resolveDefault<typeof _traverse.default>(_traverse)
const generate = resolveDefault<typeof _generate.default>(_generate)

export interface TranslatableJSString {
  path: string
  value: string
  loc?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

export async function parseJS(
  content: string,
  isTypeScript: boolean = false,
): Promise<t.File> {
  return parse(content, {
    sourceType: 'module',
    plugins: isTypeScript ? ['typescript'] : [],
  })
}

export async function extractTranslatableStringsJS(
  ast: t.File,
): Promise<TranslatableJSString[]> {
  const results: TranslatableJSString[] = []
  let nodeCounter = 0

  traverse(ast, {
    StringLiteral(path: any) {
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
    TemplateLiteral(path: any) {
      // Skip template literals with expressions (like ${SITE_TITLE})
      if (path.node.expressions.length > 0) {
        return
      }

      // Check if it's in an object property value position
      if (path.parent.type === 'ObjectProperty' && path.parent.value === path.node) {
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

function isVariableReference(_path: any): boolean {
  return false
}

export async function reconstructJS(
  ast: t.File,
  translations: Array<{ path: string; value: string }>,
): Promise<string> {
  let stringCounter = 0
  let templateCounter = 0
  const translationMap = new Map(translations.map((t) => [t.path, t.value]))

  traverse(ast, {
    StringLiteral(path: any) {
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
    TemplateLiteral(path: any) {
      // Skip template literals with expressions
      if (path.node.expressions.length > 0) {
        return
      }

      if (path.parent.type === 'ObjectProperty' && path.parent.value === path.node) {
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
