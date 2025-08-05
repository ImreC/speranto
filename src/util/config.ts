import { resolve } from 'path'

const getPath = (path?: string) => {
  if (path) return path
  const defaultPath = ['./speranto.config.ts', './speranto.config.js'].find((p) => {
    try {
      require.resolve(resolve(process.cwd(), p))
      return true
    } catch {
      return false
    }
  })

  if (!defaultPath) {
    console.error('No config file found')
    process.exit(1)
  }
  return defaultPath
}

export const loadConfig = async (configPath?: string) => {
  const path = getPath(configPath)
  try {
    const configModule = await import(resolve(process.cwd(), path))
    const config = configModule.default
    return config
  } catch (error) {
    console.error('Error loading config:', error)
    process.exit(1)
  }
}
