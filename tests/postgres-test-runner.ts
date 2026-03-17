const COMPOSE_FILE = 'tests/docker-compose.yml'
const POSTGRES_TEST_FILE = 'tests/database/postgres.test.ts'

async function main(): Promise<void> {
  const mode = process.argv[2] || 'run'
  const composeCommand = await getComposeCommand()

  if (!composeCommand) {
    console.error('Error: Docker Compose is required to run PostgreSQL tests.')
    process.exit(1)
  }

  if (mode === 'down') {
    await runCommand([...composeCommand, '-f', COMPOSE_FILE, 'down'])
    return
  }

  await runCommand([...composeCommand, '-f', COMPOSE_FILE, 'up', '-d', '--wait', 'postgres'])
  await runCommand(['bun', 'test', POSTGRES_TEST_FILE], {
    env: {
      ...process.env,
      LLM_API_KEY: 'test',
    },
  })
}

async function getComposeCommand(): Promise<string[] | null> {
  if (await commandSucceeds(['docker', 'compose', 'version'])) {
    return ['docker', 'compose']
  }

  if (await commandSucceeds(['docker-compose', 'version'])) {
    return ['docker-compose']
  }

  return null
}

async function commandSucceeds(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, {
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const exitCode = await proc.exited
  return exitCode === 0
}

async function runCommand(
  cmd: string[],
  options?: {
    env?: Record<string, string | undefined>
  },
): Promise<void> {
  const proc = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: options?.env,
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

await main()
