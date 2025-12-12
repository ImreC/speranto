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

export interface SplitGroup {
  group: TranslatableGroup
  subgroups?: TranslatableGroup[]
}

export function splitLargeGroups(
  groups: TranslatableGroup[],
  maxStringsPerGroup: number,
): SplitGroup[] {
  const result: SplitGroup[] = []

  for (const group of groups) {
    if (group.strings.length <= maxStringsPerGroup) {
      result.push({ group })
      continue
    }

    // Try to split by next nesting level first
    const subgroups = splitByNextLevel(group)

    if (subgroups.length > 1) {
      // Successfully split by nesting, but some subgroups might still be too large
      const finalSubgroups: TranslatableGroup[] = []
      for (const subgroup of subgroups) {
        if (subgroup.strings.length <= maxStringsPerGroup) {
          finalSubgroups.push(subgroup)
        } else {
          // Subgroup still too large, split numerically
          finalSubgroups.push(...splitNumerically(subgroup, maxStringsPerGroup))
        }
      }
      result.push({ group, subgroups: finalSubgroups })
    } else {
      // Couldn't split by nesting, split numerically
      result.push({ group, subgroups: splitNumerically(group, maxStringsPerGroup) })
    }
  }

  return result
}

function splitByNextLevel(group: TranslatableGroup): TranslatableGroup[] {
  // Group strings by their second path element (first level under the group key)
  const subgroupMap = new Map<string, Array<{ path: string[]; value: string }>>()

  for (const str of group.strings) {
    // path[0] is the group key, path[1] is the next level
    const subKey = str.path[1] || '_flat'

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

function splitNumerically(
  group: TranslatableGroup,
  maxStringsPerGroup: number,
): TranslatableGroup[] {
  const chunks: TranslatableGroup[] = []
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
