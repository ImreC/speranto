const originalBunFile = Bun.file.bind(Bun)

export const mockBunFile = (path: string | number) => {
  // Only mock language instructions files (when path is a string)
  if (
    typeof path === 'string' &&
    path.includes('instructions/') &&
    path.endsWith('.md')
  ) {
    return {
      exists: async () => false,
      text: async () => '',
    }
  }
  // Pass through to real Bun.file for everything else
  return originalBunFile(path as string)
}
