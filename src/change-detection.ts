interface StringEntry {
  key: string
  value: string
}

export interface ChangeResult {
  changed: StringEntry[]
  context: StringEntry[]
}

export function detectChanges(
  sourceStrings: StringEntry[],
  existingTranslations: Map<string, string>,
): ChangeResult {
  const changed: StringEntry[] = []
  const context: StringEntry[] = []

  for (const { key, value } of sourceStrings) {
    const existingTranslation = existingTranslations.get(key)

    if (existingTranslation === undefined) {
      changed.push({ key, value })
    } else {
      context.push({ key, value: existingTranslation })
    }
  }

  return { changed, context }
}
