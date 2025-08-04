export interface TranslatableJSON {
  [key: string]: string | TranslatableJSON
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

export async function reconstructJSON(
  original: TranslatableJSON,
  translations: Array<{ path: string[]; value: string }>,
): Promise<TranslatableJSON> {
  const result = JSON.parse(JSON.stringify(original))

  for (const { path, value } of translations) {
    let current: any = result
    for (let i = 0; i < path.length - 1; i++) {
      current = current[path[i]]
    }
    current[path[path.length - 1]] = value
  }

  return result
}
