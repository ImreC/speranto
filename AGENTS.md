# AGENTS.md

Guidelines for AI coding agents working in this repository.

## Project Overview

Speranto is a machine translation CLI tool for i18n in web apps. It translates JSON, JS/TS,
Markdown files and database content using LLM providers (OpenAI, Mistral, Ollama).

Published to npm as `@speranto/speranto` and to JSR as `@speranto/speranto`.

## CLI Flags

- `--retranslate` / `-r` — Force retranslation of all values, even if already translated
- `--init` — Build state from existing translations without translating (populates `.speranto/`
  sidecar from existing source+target file pairs)

## Build/Lint/Test Commands

Use Bun instead of Node.js for all tooling:

```bash
# Install dependencies
bun install

# Run ALL tests including PostgreSQL (requires Docker)
bun run test

# Run all tests except PostgreSQL (no Docker needed)
bun run test:no-docker

# Run only PostgreSQL tests (starts Docker automatically)
bun run test:postgres

# Run only SQLite tests
bun run test:sqlite

# Stop the PostgreSQL Docker container
bun run test:db:down

# Run a single test file
LLM_API_KEY=test bun test tests/translator.test.ts

# Run tests matching a pattern
LLM_API_KEY=test bun test --filter "parseJSON"

# Build the package (uses tsdown)
bun run build

# Type check (no emit)
tsc --noEmit
```

Note: Tests require `LLM_API_KEY=test`. The package script sets this automatically for
`bun run test`; for direct `bun test ...` invocations, set it manually.

## Code Style

### Formatting (Prettier)

- No semicolons
- Single quotes (including JSX)
- Trailing commas (all)
- 95 character line width
- 2-space indentation

```typescript
// Correct
const config: Config = {
  model: 'gpt-4o-mini',
  temperature: 0.0,
}

// Incorrect
const config: Config = {
  model: "gpt-4o-mini";
  temperature: 0.0;
};
```

### Imports

Order imports as follows:
1. Node.js built-in modules (use `node:` prefix)
2. External packages
3. Internal modules (relative paths)
4. Type-only imports (use `type` keyword)

For built-ins, prefer the `node:` prefix in new code. Some existing files still use bare imports
like `path`.

```typescript
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { glob } from 'glob'
import { Translator } from './translator'
import type { Config, FileConfig } from './types'
```

### Types

- Use `interface` for object shapes, `type` for unions/aliases
- Export types from dedicated type files (`src/types.ts`, `src/config.ts`)
- Use explicit return types for public functions
- Prefer `unknown` over `any`; use `any` only when truly necessary
- Use non-null assertion (`!`) sparingly and only when certain

```typescript
// Interface for object shapes
export interface TranslatorOptions {
  model: string
  temperature: number
  sourceLang: string
  targetLang: string
}

// Type for unions
type Provider = 'openai' | 'ollama' | 'mistral'
```

### Naming Conventions

- `camelCase` for functions, variables, parameters
- `PascalCase` for classes, interfaces, types, enums
- Prefix private class members with nothing (TypeScript private keyword suffices)
- Use descriptive names; avoid abbreviations

### Error Handling

- Use try/catch with empty catch block for non-critical failures (e.g., loading optional files)
- Throw `Error` with descriptive message for critical failures
- Use `console.error` for user-facing errors in CLI
- Use `console.warn` for non-fatal warnings

```typescript
// Non-critical: silently ignore
try {
  const existingContent = await readFile(targetPath, 'utf-8')
} catch {
  // Could not parse existing, will retranslate all
}

// Critical: throw with message
if (!key) {
  throw new Error(
    'OpenAI API key is required. Set LLM_API_KEY environment variable or pass it to the constructor.',
  )
}
```

### Comments

Avoid comments. Prefer:
- Clear, descriptive function names
- Good code splitting into small functions
- Self-documenting code

Only add comments when truly necessary to explain non-obvious behavior.

## API Usage

**Important:** This package is published to npm/jsr as a universal Node-compatible package.

### Runtime Code (src/)

Use Node.js APIs, NOT Bun-specific APIs:

```typescript
// Correct
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'

// Incorrect - do NOT use in runtime code
Bun.file()
Bun.write()
```

### Test/Build Code

Bun-specific APIs are allowed in:
- Test files (`tests/`)
- Build scripts (`tsdown.config.ts`)
- Development tooling

## Testing

### Test Structure

- Test files go in `tests/` directory, mirroring `src/` structure
- Use `bun:test` for test utilities
- Create mocks in `tests/mocks/`

### Test Categories

| Command | What it runs | Docker needed? |
|---|---|---|
| `bun run test` | **All tests** including PostgreSQL | Yes |
| `bun run test:no-docker` | All tests **except** PostgreSQL | No |
| `bun run test:sqlite` | SQLite adapter + orchestration tests | No |
| `bun run test:postgres` | PostgreSQL adapter tests (auto-starts Docker) | Yes |
| `bun run test:db:down` | Stops the PostgreSQL Docker container | — |

`bun run test` runs the non-Docker tests first, then automatically starts the PostgreSQL Docker
container and runs postgres tests via the test runner. New test files in `tests/*.test.ts` and
`tests/parsers/` are picked up automatically. Database test files in `tests/database/` must be
added to the `test:no-docker` script explicitly (to keep postgres excluded).

### PostgreSQL Tests — READ THIS BEFORE RUNNING

PostgreSQL tests ALWAYS fail with `PostgresError: Connection closed` if you run them via
`bun test` directly. They require Docker and MUST be run through the dedicated test runner:

```bash
# CORRECT — these both work
bun run test              # runs everything including postgres
bun run test:postgres     # runs only postgres tests

# WRONG — will fail with connection errors
bun test tests/database/postgres.test.ts
LLM_API_KEY=test bun test tests/database/postgres.test.ts
```

The test runner (`tests/postgres-test-runner.ts`):
1. Detects `docker compose` or `docker-compose` command
2. Starts PostgreSQL 16 via `tests/docker-compose.yml` (port 5432, user/pass: test/test, db: speranto_test)
3. Waits for the health check (`pg_isready`)
4. Runs `bun test tests/database/postgres.test.ts` with `LLM_API_KEY=test`

The container keeps running after tests finish. Use `bun run test:db:down` to stop it, or
rerun `bun run test:postgres` to reuse the existing container.

If port 5432 is already in use (e.g., a local PostgreSQL), stop it first or the container
will fail to bind.

### Test Files Overview

- `tests/translate.test.ts` — End-to-end file translation orchestration (JSON, JS/TS, Markdown).
  Tests hash-based skip logic, partial retranslation, sidecar state restoration, and `retranslate` flag.
- `tests/database/orchestrate-sqlite.test.ts` — End-to-end database translation orchestration
  using SQLite. Tests duplicate row prevention, hash-based skip, partial field retranslation,
  `langColumn` per-row source language, and `retranslate` flag.
- `tests/database/sqlite.test.ts` — SQLite adapter unit tests (CRUD, upsert, table creation).
- `tests/database/postgres.test.ts` — PostgreSQL adapter unit tests (same interface as SQLite).
- `tests/parsers/*.test.ts` — Parser unit tests for JSON, JS/TS, and Markdown.
- `tests/translator.test.ts` — Translator class tests (prompt construction, LLM interaction).
- `tests/providers.test.ts` — LLM provider instantiation tests.

### Mocking

For LLM providers, use `MockLLMProvider` from `tests/mocks/LLMProvider.ts` to avoid
real API calls in tests.

### Duplicate Prevention Testing

The codebase uses SHA256 hashes at row and field level to skip unchanged translations.
Tests verify this at two levels:

**File orchestration** (`translate.test.ts`):
- Unchanged JSON groups produce 0 LLM calls on second run
- Adding a key to a group triggers retranslation of only that group
- Unchanged JS groups are skipped; changed groups are retranslated
- Unchanged markdown is skipped and translated content is preserved
- `retranslate: true` forces retranslation regardless of hashes

**Database orchestration** (`orchestrate-sqlite.test.ts`):
- Unchanged rows produce 0 LLM calls on second run
- Changed fields trigger retranslation; unchanged fields are reused
- Multiple runs with `retranslate: true` do not create duplicate rows (upsert on source_id+lang)
- `retranslate: true` forces retranslation regardless of hashes

**Adapter level** (`sqlite.test.ts`, `postgres.test.ts`):
- `upsertTranslation` with same source_id+lang updates the existing row (no duplicates)

## Project Structure

```
index.ts              # CLI entry point (Commander.js)
src/
├── config.ts         # Configuration types (exported to consumers)
├── orchestrate.ts    # Main file/database orchestration
├── orchestrate-database.ts  # Database translation orchestration
├── translator.ts     # Core Translator class (prompt construction, LLM calls)
├── types.ts          # Extended Config type for internal use
├── database/
│   ├── adapter.ts    # Abstract DatabaseAdapter base class
│   ├── index.ts      # Database adapter factory
│   ├── sqlite.ts     # SQLite adapter (sql.js)
│   └── postgres.ts   # PostgreSQL adapter (pg)
├── interface/
│   ├── llm.interface.ts  # Abstract LLMInterface base class
│   ├── index.ts      # Provider exports
│   └── openai-compatible.ts  # OpenAI-compatible provider for OpenAI/Mistral/Ollama/custom APIs
├── parsers/
│   ├── json.ts       # JSON file parser
│   ├── js.ts         # JS/TS parser (Babel)
│   └── md.ts         # Markdown parser (Remark)
└── util/
    ├── config.ts     # Config file loading utility
    ├── hash.ts       # Shared row/group hash helpers
    └── file-state.ts # Sidecar file translation state
tests/
├── mocks/
│   ├── LLMProvider.ts    # Mock LLM provider
│   └── BunFile.ts
├── database/
│   ├── sqlite.test.ts
│   ├── postgres.test.ts
│   └── orchestrate-sqlite.test.ts
├── parsers/
│   ├── json.test.ts
│   ├── js.test.ts
│   └── md.test.ts
├── translator.test.ts
├── translate.test.ts
├── providers.test.ts
├── postgres-test-runner.ts   # Docker-backed PostgreSQL test runner
└── docker-compose.yml    # PostgreSQL for database tests
```

## Architecture Notes

- `LLMInterface` is the abstract base class for LLM providers (`generate`, `isModelLoaded`)
- `OpenAICompatibleProvider` handles OpenAI, Mistral, Ollama, and arbitrary OpenAI-compatible
  endpoints
- `DatabaseAdapter` is the abstract base class for database backends
- Parsers extract translatable strings and reconstruct files after translation
- Translation is orchestrated via Listr2 for progress display
- Database translations store base-language rows in translation tables, making them the canonical
  read model for all languages
- Database change detection uses row-level and per-field hashes
- File translation state is stored in a sidecar `.speranto/` directory (relative to `process.cwd()`)
  and uses hash-based file/group/chunk detection
- `--init` populates state from existing source+target pairs without calling the LLM
- `excludeKeys` in file config skips specified leaf keys from translation (e.g., `localizedSlug`).
  For JSON files, excluded keys are merged back from existing target files via `mergeExcludedKeys`.
  For JS/TS files, excluded key values are preserved from existing target files via positional
  matching in `collectJSWorkItems`
- `parseGroupResponse` in the Translator validates that LLM responses contain string values. If
  the LLM returns an object with a `value` property instead of a plain string, the string is
  extracted automatically
- Set `concurrency: 1` to process translations sequentially on low rate-limit setups
- Default provider is `mistral` with model `mistral-large-latest`
- CLI options override config file values; config loaded from `speranto.config.ts` or `.js`
