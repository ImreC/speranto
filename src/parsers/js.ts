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
  objectPath: string[]
  value: string
  loc?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

export interface TranslatableJSGroup {
  groupKey: string
  strings: TranslatableJSString[]
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

function getObjectPath(path: any): string[] {
  const objectPath: string[] = []
  let current = path.parentPath

  while (current) {
    if (current.node.type === 'ObjectProperty' && current.node.key) {
      const key = current.node.key
      if (key.type === 'Identifier') {
        objectPath.unshift(key.name)
      } else if (key.type === 'StringLiteral') {
        objectPath.unshift(key.value)
      }
    }
    current = current.parentPath
  }

  return objectPath
}

export async function extractTranslatableStringsJS(
  ast: t.File,
): Promise<TranslatableJSString[]> {
  const results: TranslatableJSString[] = []
  let nodeCounter = 0

  traverse(ast, {
    StringLiteral(path: any) {
      if (
        path.parent.type === 'ObjectProperty' &&
        path.parent.value === path.node &&
        !isVariableReference(path)
      ) {
        const objectPath = getObjectPath(path)
        results.push({
          path: `string_${nodeCounter++}`,
          objectPath,
          value: path.node.value,
          loc: path.node.loc || undefined,
        })
      }
    },
    TemplateLiteral(path: any) {
      if (path.node.expressions.length > 0) {
        return
      }

      if (path.parent.type === 'ObjectProperty' && path.parent.value === path.node) {
        const value = path.node.quasis[0].value.raw
        const objectPath = getObjectPath(path)
        results.push({
          path: `template_${nodeCounter++}`,
          objectPath,
          value,
          loc: path.node.loc || undefined,
        })
      }
    },
  })

  return results
}

export async function extractTranslatableGroupsJS(
  ast: t.File,
): Promise<TranslatableJSGroup[]> {
  const strings = await extractTranslatableStringsJS(ast)
  const groups = new Map<string, TranslatableJSString[]>()

  for (const item of strings) {
    let groupKey: string

    if (item.objectPath.length >= 2) {
      // Nested structure: use the first level as group key (e.g., "nav" from ["nav", "home"])
      groupKey = item.objectPath[0]!
    } else if (item.objectPath.length === 1) {
      // Single level: check for dot notation in the key itself
      const key = item.objectPath[0]!
      const dotIndex = key.indexOf('.')
      groupKey = dotIndex > 0 ? key.substring(0, dotIndex) : '_root'
    } else {
      groupKey = '_root'
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, [])
    }
    groups.get(groupKey)!.push(item)
  }

  return Array.from(groups.entries()).map(([groupKey, strings]) => ({
    groupKey,
    strings,
  }))
}

function isVariableReference(_path: any): boolean {
  return false
}

export interface SplitJSGroup {
  group: TranslatableJSGroup
  subgroups?: TranslatableJSGroup[]
}

export function splitLargeGroupsJS(
  groups: TranslatableJSGroup[],
  maxStringsPerGroup: number,
): SplitJSGroup[] {
  const result: SplitJSGroup[] = []

  for (const group of groups) {
    if (group.strings.length <= maxStringsPerGroup) {
      result.push({ group })
      continue
    }

    // Try to split by next nesting level first
    const subgroups = splitByNextLevelJS(group)

    if (subgroups.length > 1) {
      // Successfully split by nesting, but some subgroups might still be too large
      const finalSubgroups: TranslatableJSGroup[] = []
      for (const subgroup of subgroups) {
        if (subgroup.strings.length <= maxStringsPerGroup) {
          finalSubgroups.push(subgroup)
        } else {
          // Subgroup still too large, split numerically
          finalSubgroups.push(...splitNumericallyJS(subgroup, maxStringsPerGroup))
        }
      }
      result.push({ group, subgroups: finalSubgroups })
    } else {
      // Couldn't split by nesting, split numerically
      result.push({ group, subgroups: splitNumericallyJS(group, maxStringsPerGroup) })
    }
  }

  return result
}

function splitByNextLevelJS(group: TranslatableJSGroup): TranslatableJSGroup[] {
  // Group strings by their second objectPath element
  const subgroupMap = new Map<string, TranslatableJSString[]>()

  for (const str of group.strings) {
    // objectPath[0] is the group key, objectPath[1] is the next level
    const subKey = str.objectPath[1] || '_flat'

    if (!subgroupMap.has(subKey)) {
      subgroupMap.set(subKey, [])
    }
    subgroupMap.get(subKey)!.push(str)
  }

  // If we only got one subgroup or no meaningful split, return original
  if (subgroupMap.size <= 1) {
    return [group]
  }

  return Array.from(subgroupMap.entries()).map(([subKey, strings]) => ({
    groupKey: `${group.groupKey}.${subKey}`,
    strings,
  }))
}

function splitNumericallyJS(
  group: TranslatableJSGroup,
  maxStringsPerGroup: number,
): TranslatableJSGroup[] {
  const chunks: TranslatableJSGroup[] = []
  const totalChunks = Math.ceil(group.strings.length / maxStringsPerGroup)

  for (let i = 0; i < group.strings.length; i += maxStringsPerGroup) {
    const chunkIndex = Math.floor(i / maxStringsPerGroup) + 1
    chunks.push({
      groupKey: `${group.groupKey} (${chunkIndex}/${totalChunks})`,
      strings: group.strings.slice(i, i + maxStringsPerGroup),
    })
  }

  return chunks
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
