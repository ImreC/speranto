import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageName = '@speranto/speranto'
const managedBlockStart = '<!-- speranto-agent-docs:start -->'
const managedBlockEnd = '<!-- speranto-agent-docs:end -->'
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type AgentDocsMode = 'install' | 'check' | 'remove'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface InstalledManifest {
  package: string
  packageVersion: string
  guideChecksum: string
  source: string
  instructionFiles: string[]
  createdInstructionFiles: string[]
}

interface InstructionPlan {
  path: string
  relativePath: string
  existed: boolean
  currentContent: string
  desiredContent: string
}

export interface ManageAgentDocsOptions {
  mode?: AgentDocsMode
  projectRoot?: string
  dependencyRoot?: string
  sourceGuidePath?: string
  packageVersion?: string
  postinstall?: boolean
}

export interface ManageAgentDocsResult {
  status: 'installed' | 'updated' | 'current' | 'stale' | 'removed' | 'skipped'
  projectRoot: string
  changedFiles: string[]
  warnings: string[]
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (isNotFound(error)) {
      return undefined
    }
    throw error
  }
}

async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T
}

async function readOptionalJSON<T>(path: string): Promise<T | undefined> {
  try {
    return await readJSON<T>(path)
  } catch {
    return undefined
  }
}

function ensureInsideProject(projectRoot: string, targetPath: string): void {
  const relativePath = relative(projectRoot, targetPath)
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return
  }
  throw new Error(`Refusing to write outside the project root: ${targetPath}`)
}

async function ensureNoSymlinks(projectRoot: string, targetPath: string): Promise<void> {
  ensureInsideProject(projectRoot, targetPath)
  const relativePath = relative(projectRoot, targetPath)
  const pathParts = relativePath.split(sep).filter(Boolean)
  let currentPath = projectRoot

  for (const pathPart of pathParts) {
    currentPath = join(currentPath, pathPart)
    try {
      const stats = await lstat(currentPath)
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to update a symbolic link: ${currentPath}`)
      }
    } catch (error) {
      if (isNotFound(error)) {
        return
      }
      throw error
    }
  }
}

async function writeFileAtomically(
  projectRoot: string,
  targetPath: string,
  content: string,
): Promise<void> {
  await ensureNoSymlinks(projectRoot, targetPath)
  await mkdir(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, 'utf-8')
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

async function findProjectRoot(startPath: string): Promise<string> {
  let currentPath = resolve(startPath)
  try {
    if (!(await lstat(currentPath)).isDirectory()) {
      currentPath = dirname(currentPath)
    }
  } catch {
    throw new Error(`Could not access the project path: ${startPath}`)
  }

  while (true) {
    if (await pathExists(join(currentPath, 'package.json'))) {
      return currentPath
    }
    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      throw new Error(`Could not find package.json from ${startPath}`)
    }
    currentPath = parentPath
  }
}

function hasDirectDependency(manifest: PackageManifest): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
    (dependencies) => dependencies && packageName in dependencies,
  )
}

function countOccurrences(content: string, value: string): number {
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(value, offset)) !== -1) {
    count += 1
    offset += value.length
  }
  return count
}

function lineEndingFor(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

function relativeImportPath(instructionPath: string, guidePath: string): string {
  return relative(dirname(instructionPath), guidePath).split(sep).join('/')
}

function createManagedBlock(
  instructionPath: string,
  guidePath: string,
  lineEnding: string,
): string {
  const importPath = relativeImportPath(instructionPath, guidePath)
  return [
    managedBlockStart,
    '## Speranto',
    '',
    'When working with localization, Speranto configuration, or translated content, ' +
      `read and follow @${importPath}.`,
    managedBlockEnd,
  ].join(lineEnding)
}

function addOrReplaceManagedBlock(
  content: string,
  instructionPath: string,
  guidePath: string,
): string {
  const startCount = countOccurrences(content, managedBlockStart)
  const endCount = countOccurrences(content, managedBlockEnd)
  if (startCount !== endCount || startCount > 1) {
    throw new Error(`Malformed Speranto managed block in ${instructionPath}`)
  }

  const lineEnding = lineEndingFor(content)
  const block = createManagedBlock(instructionPath, guidePath, lineEnding)
  if (startCount === 1) {
    const startIndex = content.indexOf(managedBlockStart)
    const endIndex = content.indexOf(managedBlockEnd, startIndex) + managedBlockEnd.length
    return `${content.slice(0, startIndex)}${block}${content.slice(endIndex)}`
  }

  if (content.length === 0) {
    return `${block}${lineEnding}`
  }
  const separator = content.endsWith(`${lineEnding}${lineEnding}`)
    ? ''
    : content.endsWith(lineEnding)
      ? lineEnding
      : `${lineEnding}${lineEnding}`
  return `${content}${separator}${block}${lineEnding}`
}

function removeManagedBlock(content: string, instructionPath: string): string {
  const startCount = countOccurrences(content, managedBlockStart)
  const endCount = countOccurrences(content, managedBlockEnd)
  if (startCount === 0 && endCount === 0) {
    return content
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Malformed Speranto managed block in ${instructionPath}`)
  }

  const startIndex = content.indexOf(managedBlockStart)
  const endIndex = content.indexOf(managedBlockEnd, startIndex) + managedBlockEnd.length
  const before = content.slice(0, startIndex).replace(/[ \t]+$/, '')
  const after = content.slice(endIndex).replace(/^(?:\r?\n){0,2}/, '')
  if (before.length === 0) {
    return after
  }
  if (after.length === 0) {
    return before.replace(/(?:\r?\n){1,2}$/, '') + lineEndingFor(content)
  }
  return `${before}${lineEndingFor(content)}${after}`
}

function importsAgentsFile(content: string, claudePath: string, agentsPath: string): boolean {
  const imports = content.matchAll(/@([^\s`]+)/g)
  for (const match of imports) {
    const importedPath = match[1]?.replace(/[),.;:]+$/, '')
    if (importedPath && resolve(dirname(claudePath), importedPath) === agentsPath) {
      return true
    }
  }
  return false
}

async function selectInstructionPaths(projectRoot: string): Promise<string[]> {
  const agentsPath = join(projectRoot, 'AGENTS.md')
  const claudePaths = [
    join(projectRoot, 'CLAUDE.md'),
    join(projectRoot, '.claude', 'CLAUDE.md'),
  ]
  const agentsExists = await pathExists(agentsPath)
  const existingClaudePaths: string[] = []

  for (const claudePath of claudePaths) {
    if (await pathExists(claudePath)) {
      existingClaudePaths.push(claudePath)
    }
  }

  if (!agentsExists && existingClaudePaths.length === 0) {
    return [agentsPath]
  }

  const selectedPaths = agentsExists ? [agentsPath] : []
  for (const claudePath of existingClaudePaths) {
    const content = (await readOptionalFile(claudePath)) ?? ''
    if (!agentsExists || !importsAgentsFile(content, claudePath, agentsPath)) {
      selectedPaths.push(claudePath)
    }
  }
  return selectedPaths
}

async function createInstructionPlans(
  projectRoot: string,
  guidePath: string,
  warnings: string[],
): Promise<InstructionPlan[]> {
  const instructionPaths = await selectInstructionPaths(projectRoot)
  const plans: InstructionPlan[] = []

  for (const instructionPath of instructionPaths) {
    const existingContent = await readOptionalFile(instructionPath)
    try {
      plans.push({
        path: instructionPath,
        relativePath: relative(projectRoot, instructionPath).split(sep).join('/'),
        existed: existingContent !== undefined,
        currentContent: existingContent ?? '',
        desiredContent: addOrReplaceManagedBlock(
          existingContent ?? '',
          instructionPath,
          guidePath,
        ),
      })
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }
  return plans
}

function checksum(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

async function resolvePackageVersion(versionOverride?: string): Promise<string> {
  if (versionOverride) {
    return versionOverride
  }
  const manifest = await readJSON<{ version: string }>(join(moduleRoot, 'package.json'))
  return manifest.version
}

async function removeAgentDocs(projectRoot: string): Promise<ManageAgentDocsResult> {
  const managedDirectory = join(projectRoot, '.agents', 'speranto')
  const installedManifest = await readOptionalJSON<InstalledManifest>(
    join(managedDirectory, 'manifest.json'),
  )
  const candidatePaths = new Set([
    join(projectRoot, 'AGENTS.md'),
    join(projectRoot, 'CLAUDE.md'),
    join(projectRoot, '.claude', 'CLAUDE.md'),
    ...(installedManifest?.instructionFiles.map((path) => join(projectRoot, path)) ?? []),
  ])
  const createdFiles = new Set(installedManifest?.createdInstructionFiles ?? [])
  const changedFiles: string[] = []
  const warnings: string[] = []

  for (const instructionPath of candidatePaths) {
    const content = await readOptionalFile(instructionPath)
    if (content === undefined || !content.includes(managedBlockStart)) {
      continue
    }
    try {
      const updatedContent = removeManagedBlock(content, instructionPath)
      const relativePath = relative(projectRoot, instructionPath).split(sep).join('/')
      await ensureNoSymlinks(projectRoot, instructionPath)
      if (updatedContent.trim().length === 0 && createdFiles.has(relativePath)) {
        await unlink(instructionPath)
      } else {
        await writeFileAtomically(projectRoot, instructionPath, updatedContent)
      }
      changedFiles.push(relativePath)
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (warnings.length === 0 && (await pathExists(managedDirectory))) {
    await ensureNoSymlinks(projectRoot, managedDirectory)
    await rm(managedDirectory, { recursive: true })
    changedFiles.push('.agents/speranto')
  }

  return {
    status: changedFiles.length > 0 ? 'removed' : 'current',
    projectRoot,
    changedFiles,
    warnings,
  }
}

export async function manageAgentDocs(
  options: ManageAgentDocsOptions = {},
): Promise<ManageAgentDocsResult> {
  const mode = options.mode ?? 'install'
  const projectRoot = await realpath(
    await findProjectRoot(options.projectRoot ?? process.cwd()),
  )
  const projectManifest = await readJSON<PackageManifest>(join(projectRoot, 'package.json'))
  const dependencyRoot = options.dependencyRoot
    ? await realpath(await findProjectRoot(options.dependencyRoot))
    : projectRoot
  const dependencyManifest =
    dependencyRoot === projectRoot
      ? projectManifest
      : await readJSON<PackageManifest>(join(dependencyRoot, 'package.json'))

  if (
    options.postinstall &&
    (process.env.SPERANTO_SKIP_AGENT_DOCS === '1' ||
      process.env.SPERANTO_SKIP_AGENT_DOCS === 'true' ||
      dependencyManifest.name === packageName ||
      !hasDirectDependency(dependencyManifest))
  ) {
    return {
      status: 'skipped',
      projectRoot,
      changedFiles: [],
      warnings: [],
    }
  }

  if (mode === 'remove') {
    return removeAgentDocs(projectRoot)
  }

  const sourceGuidePath = options.sourceGuidePath ?? join(moduleRoot, 'docs', 'agent-guide.md')
  const guideContent = await readFile(sourceGuidePath, 'utf-8')
  const managedDirectory = join(projectRoot, '.agents', 'speranto')
  const guidePath = join(managedDirectory, 'guide.md')
  const manifestPath = join(managedDirectory, 'manifest.json')
  const warnings: string[] = []
  const guideWasInstalled = await pathExists(guidePath)
  const instructionPlans = await createInstructionPlans(projectRoot, guidePath, warnings)
  const previousManifest = await readOptionalJSON<InstalledManifest>(manifestPath)
  const createdInstructionFiles = new Set(previousManifest?.createdInstructionFiles ?? [])
  for (const plan of instructionPlans) {
    if (!plan.existed) {
      createdInstructionFiles.add(plan.relativePath)
    }
  }

  const installedManifest: InstalledManifest = {
    package: packageName,
    packageVersion: await resolvePackageVersion(options.packageVersion),
    guideChecksum: checksum(guideContent),
    source: 'docs/agent-guide.md',
    instructionFiles: instructionPlans.map((plan) => plan.relativePath),
    createdInstructionFiles: [...createdInstructionFiles].sort(),
  }
  const manifestContent = `${JSON.stringify(installedManifest, null, 2)}\n`
  const changedFiles: string[] = []

  if ((await readOptionalFile(guidePath)) !== guideContent) {
    changedFiles.push('.agents/speranto/guide.md')
  }
  if ((await readOptionalFile(manifestPath)) !== manifestContent) {
    changedFiles.push('.agents/speranto/manifest.json')
  }
  for (const plan of instructionPlans) {
    if (plan.currentContent !== plan.desiredContent) {
      changedFiles.push(plan.relativePath)
    }
  }

  if (mode === 'check') {
    return {
      status: changedFiles.length > 0 ? 'stale' : 'current',
      projectRoot,
      changedFiles,
      warnings,
    }
  }

  if ((await readOptionalFile(guidePath)) !== guideContent) {
    await writeFileAtomically(projectRoot, guidePath, guideContent)
  }
  for (const plan of instructionPlans) {
    if (plan.currentContent !== plan.desiredContent) {
      await writeFileAtomically(projectRoot, plan.path, plan.desiredContent)
    }
  }
  if ((await readOptionalFile(manifestPath)) !== manifestContent) {
    await writeFileAtomically(projectRoot, manifestPath, manifestContent)
  }

  const wasInstalled = previousManifest !== undefined || guideWasInstalled
  return {
    status: changedFiles.length === 0 ? 'current' : wasInstalled ? 'updated' : 'installed',
    projectRoot,
    changedFiles,
    warnings,
  }
}
