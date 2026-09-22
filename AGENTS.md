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

Use pnpm and Node.js for all tooling:

```bash
# Install dependencies
pnpm install

# Start PostgreSQL and run the complete test suite
pnpm test

# Stop the PostgreSQL Docker container
docker compose -p speranto -f tests/docker-compose.yml down

# Run a single test file
LLM_API_KEY=test pnpm exec vitest run tests/translator.test.ts

# Run tests matching a pattern
LLM_API_KEY=test pnpm exec vitest run -t "parseJSON"

# Build the package (uses tsdown)
pnpm build

# Type check (no emit)
pnpm exec tsc --noEmit
```

`pnpm test` starts the PostgreSQL 16 container and sets `LLM_API_KEY=test`. For direct
`vitest ...` invocations, set that environment variable manually. PostgreSQL tests also require
the container, which can be started independently with `pnpm docker:up`.

Run `pnpm exec tsc --noEmit` after each code change and check for errors.

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

Use Node.js APIs, not runtime-specific alternatives:

```typescript
// Correct
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'

// Incorrect - do NOT use APIs from other JavaScript runtimes
Deno.readTextFile()
```

### Test/Build Code

Test-runner and build-tool APIs are allowed in:

- Test files (`tests/`)
- Build scripts (`tsdown.config.ts`)
- Development tooling

## Testing

### Test Structure

- Test files go in `tests/` directory, mirroring `src/` structure
- Use Vitest for test utilities
- Create mocks in `tests/mocks/`

### Running Tests

```bash
# Run all tests
pnpm test

# Start PostgreSQL without running tests
pnpm docker:up

# Run the PostgreSQL adapter tests directly after starting the container
LLM_API_KEY=test pnpm exec vitest run tests/database/postgres.test.ts
```

`pnpm test` runs `pnpm docker:up && LLM_API_KEY=test vitest run`, which discovers all test
files automatically. PostgreSQL runs from `tests/docker-compose.yml` on port 5432 with user/password
`test` and database `speranto_test`.

### Test Files Overview

- `tests/translate.test.ts` — End-to-end file translation orchestration (JSON, JS/TS, Markdown).
  Tests hash-based skip logic, partial retranslation, sidecar state restoration, failure
  propagation, duplicate JS property paths, and the `retranslate` flag.
- `tests/database/orchestrate-sqlite.test.ts` — End-to-end database translation orchestration
  using SQLite. Tests duplicate row prevention, hash-based skip, partial field retranslation,
  `langColumn` per-row source language, concurrency precedence, cleanup after failures, and the
  `retranslate` flag.
- `tests/database/sqlite.test.ts` — SQLite adapter unit tests (CRUD, upsert, table creation).
- `tests/database/postgres.test.ts` — PostgreSQL adapter unit tests (same interface as SQLite).
- `tests/parsers/*.test.ts` — Parser unit tests for JSON, JS/TS, and Markdown, including mixed JS
  literal reconstruction.
- `tests/translator.test.ts` — Translator tests for prompt construction, asynchronous setup, LLM
  interaction, and strict response validation.
- `tests/providers.test.ts` — LLM provider instantiation tests.
- `tests/cli.test.ts` — CLI tests for configuration-driven init mode and option validation.
- `tests/util/concurrency.test.ts` — Concurrency defaulting and validation tests.

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
    ├── concurrency.ts # Concurrency defaulting and validation
    ├── config.ts      # Config file loading utility
    ├── file-state.ts  # Sidecar file translation state
    └── hash.ts        # Shared row/group hash helpers
tests/
├── cli.test.ts
├── docker-compose.yml    # PostgreSQL for database tests
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
├── providers.test.ts
├── translate.test.ts
├── translator.test.ts
└── util/
    └── concurrency.test.ts
```

## Architecture Notes

- `LLMInterface` is the abstract base class for LLM providers (`generate`, `isModelLoaded`)
- `OpenAICompatibleProvider` handles OpenAI, Mistral, Ollama, and arbitrary OpenAI-compatible
  endpoints
- `DatabaseAdapter` is the abstract base class for database backends
- Parsers extract translatable strings and reconstruct files after translation
- Translation is orchestrated via Listr2 for progress display
- Translation failures propagate to the CLI, which exits non-zero; failed file groups do not
  update output files or sidecar state
- Database translations store base-language rows in translation tables, making them the canonical
  read model for all languages
- Database change detection uses row-level and per-field hashes
- File translation state is stored in a sidecar `.speranto/` directory (relative to `process.cwd()`)
  and uses hash-based file/group/chunk detection
- `--init` or `init: true` populates state from existing source+target pairs without calling the LLM
- `excludeKeys` in file config skips specified leaf keys from translation (e.g., `localizedSlug`).
  For JSON files, excluded keys are merged back from existing target files via `mergeExcludedKeys`.
  For JS/TS files, excluded key values are preserved from existing target files via positional
  matching in `collectJSWorkItems`
- Duplicate JS/TS property paths are assigned unique translation keys so every occurrence can be
  reconstructed correctly
- `parseGroupResponse` requires valid JSON with every requested key and string value. An object
  with a string `value` property is also accepted for provider compatibility
- Concurrency values must be positive integers. Top-level `concurrency` defaults to 5;
  `database.concurrency` overrides it for database work and defaults to 10 when neither is set.
  Set the relevant value to 1 for sequential processing on low rate-limit setups
- Default provider is `mistral` with model `mistral-large-latest`
- CLI options override config file values; config is loaded from `speranto.config.ts` or `.js`
- Verbose output redacts API keys and database connection strings
