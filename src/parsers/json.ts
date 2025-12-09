export interface TranslatableJSON {
  [key: string]: string | TranslatableJSON
}

export interface TranslatableGroup {
  groupKey: string
  strings: Array<{ path: string[]; value: string }>
}

export async function parseJSON(content: string): Promise<TranslatableJSON> {
  return JSON.parse(content)
}

export async function stringifyJSON(data: TranslatableJSON): Promise<string> {
  return JSON.stringify(data, null, 2)
}

export async function extractTranslatableStrings(
  obj: TranslatableJSON,
  path: string[] = [],
): Promise<Array<{ path: string[]; value: string }>> {
  const results: Array<{ path: string[]; value: string }> = []

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = [...path, key]

    if (typeof value === 'string') {
      results.push({ path: currentPath, value })
    } else if (typeof value === 'object' && value !== null) {
      const nested = await extractTranslatableStrings(value as TranslatableJSON, currentPath)
      results.push(...nested)
    }
  }

  return results
}

export async function extractTranslatableGroups(
  obj: TranslatableJSON,
): Promise<TranslatableGroup[]> {
  const groups: TranslatableGroup[] = []

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Top-level strings without nesting - check for dot notation grouping
      // These will be handled separately or put in a 'root' group
      const existingRootGroup = groups.find((g) => g.groupKey === '_root')
      if (existingRootGroup) {
        existingRootGroup.strings.push({ path: [key], value })
      } else {
        groups.push({
          groupKey: '_root',
          strings: [{ path: [key], value }],
        })
      }
    } else if (typeof value === 'object' && value !== null) {
      // Nested object - this is a "page" or logical group
      const strings = await extractTranslatableStrings(value as TranslatableJSON, [key])
      if (strings.length > 0) {
        groups.push({
          groupKey: key,
          strings,
        })
      }
    }
  }

  // Now check for dot notation grouping in root strings
  const rootGroup = groups.find((g) => g.groupKey === '_root')
  if (rootGroup && rootGroup.strings.length > 0) {
    const dotGroups = groupByDotNotation(rootGroup.strings)
    // Remove the _root group
    const rootIndex = groups.indexOf(rootGroup)
    groups.splice(rootIndex, 1)
    // Add the dot-notation groups
    groups.push(...dotGroups)
  }

  return groups
}

function groupByDotNotation(
  strings: Array<{ path: string[]; value: string }>,
): TranslatableGroup[] {
  const groups = new Map<string, Array<{ path: string[]; value: string }>>()

  for (const item of strings) {
    const key = item.path[0] || ''
    // Check if key uses dot notation (e.g., "pricing.description")
    const dotIndex = key.indexOf('.')
    const groupKey = dotIndex > 0 ? key.substring(0, dotIndex) : '_ungrouped'

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

export async function reconstructJSON(
  original: TranslatableJSON,
  translations: Array<{ path: string[]; value: string }>,
): Promise<TranslatableJSON> {
  const result = JSON.parse(JSON.stringify(original)) as TranslatableJSON

  for (const { path, value } of translations) {
    let current: TranslatableJSON = result
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]
      if (key !== undefined && typeof current[key] === 'object' && current[key] !== null) {
        current = current[key] as TranslatableJSON
      }
    }
    const lastKey = path[path.length - 1]
    if (lastKey !== undefined) {
      current[lastKey] = value
    }
  }

  return result
}
