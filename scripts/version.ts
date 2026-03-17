import { readFile, writeFile } from 'node:fs/promises'

interface Manifest {
  version: string
  [key: string]: unknown
}

interface PackageManifest extends Manifest {
  name: string
  license?: string
  description?: string
}

interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const RELEASE_TYPES = new Set([
  'sync',
  'patch',
  'minor',
  'major',
  'prepatch',
  'preminor',
  'premajor',
  'prerelease',
])

const HELP = `Usage:
  bun run bump:version <patch|minor|major|prepatch|preminor|premajor|prerelease>
  bun run bump:version sync
  bun run bump:version <version>

Examples:
  bun run bump:version patch
  bun run bump:version minor
  bun run bump:version prerelease beta
  bun run bump:version 1.0.0
  bun run sync:version
`

async function readManifest(path: string | URL): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest
}

function syncJsrManifest(
  packageJson: PackageManifest,
  jsrJson: Manifest,
  version: string,
): Manifest {
  const {
    name: _jsrName,
    version: _jsrVersion,
    license: _jsrLicense,
    description: _jsrDescription,
    ...jsrSpecificFields
  } = jsrJson

  return {
    name: packageJson.name,
    version,
    ...(packageJson.license ? { license: packageJson.license } : {}),
    ...(packageJson.description ? { description: packageJson.description } : {}),
    ...jsrSpecificFields,
  }
}

function parseVersion(version: string): SemVer {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    )

  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`)
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function formatVersion(version: SemVer): string {
  const base = `${version.major}.${version.minor}.${version.patch}`

  if (version.prerelease.length === 0) {
    return base
  }

  return `${base}-${version.prerelease.join('.')}`
}

function toRelease(version: SemVer): SemVer {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    prerelease: [],
  }
}

function startPrerelease(version: SemVer, identifier: string): SemVer {
  return {
    ...version,
    prerelease: [identifier, '0'],
  }
}

function nextPrerelease(version: SemVer, identifier: string): SemVer {
  const next = { ...version, prerelease: [...version.prerelease] }

  if (next.prerelease.length === 0) {
    return startPrerelease(next, identifier)
  }

  if (next.prerelease[0] !== identifier) {
    next.prerelease = [identifier, '0']
    return next
  }

  const last = next.prerelease.at(-1)
  const lastNumber = last ? Number(last) : Number.NaN

  if (Number.isInteger(lastNumber)) {
    next.prerelease[next.prerelease.length - 1] = String(lastNumber + 1)
    return next
  }

  next.prerelease.push('0')
  return next
}

function bumpVersion(currentVersion: string, releaseType: string, identifier = 'rc'): string {
  const current = parseVersion(currentVersion)

  switch (releaseType) {
    case 'patch':
      if (current.prerelease.length > 0) {
        return formatVersion(toRelease(current))
      }

      return formatVersion({
        ...current,
        patch: current.patch + 1,
      })
    case 'minor':
      if (current.prerelease.length > 0 && current.patch === 0) {
        return formatVersion(toRelease(current))
      }

      return formatVersion({
        major: current.major,
        minor: current.minor + 1,
        patch: 0,
        prerelease: [],
      })
    case 'major':
      if (current.prerelease.length > 0 && current.minor === 0 && current.patch === 0) {
        return formatVersion(toRelease(current))
      }

      return formatVersion({
        major: current.major + 1,
        minor: 0,
        patch: 0,
        prerelease: [],
      })
    case 'prepatch':
      return formatVersion(
        startPrerelease(
          {
            major: current.major,
            minor: current.minor,
            patch: current.patch + 1,
            prerelease: [],
          },
          identifier,
        ),
      )
    case 'preminor':
      return formatVersion(
        startPrerelease(
          {
            major: current.major,
            minor: current.minor + 1,
            patch: 0,
            prerelease: [],
          },
          identifier,
        ),
      )
    case 'premajor':
      return formatVersion(
        startPrerelease(
          {
            major: current.major + 1,
            minor: 0,
            patch: 0,
            prerelease: [],
          },
          identifier,
        ),
      )
    case 'prerelease':
      return formatVersion(nextPrerelease(current, identifier))
    default:
      throw new Error(`Unsupported release type: ${releaseType}`)
  }
}

async function main(): Promise<void> {
  const [target, prereleaseIdentifier] = process.argv.slice(2)

  if (!target || target === '--help' || target === '-h') {
    console.log(HELP)

    if (!target) {
      process.exitCode = 1
    }

    return
  }

  const packagePath = new URL('../package.json', import.meta.url)
  const jsrPath = new URL('../jsr.json', import.meta.url)
  const packageJson = (await readManifest(packagePath)) as PackageManifest
  const jsrJson = await readManifest(jsrPath)

  const nextVersion =
    target === 'sync'
      ? packageJson.version
      : RELEASE_TYPES.has(target)
        ? bumpVersion(packageJson.version, target, prereleaseIdentifier)
        : formatVersion(parseVersion(target))

  packageJson.version = nextVersion
  const nextJsrJson = syncJsrManifest(packageJson, jsrJson, nextVersion)

  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  await writeFile(jsrPath, `${JSON.stringify(nextJsrJson, null, 2)}\n`)

  console.log(`Updated package.json and jsr.json to ${nextVersion}`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
