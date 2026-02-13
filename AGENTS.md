# AGENTS.md

Guidelines for AI coding agents working in this repository.

## Project Overview

Speranto is a machine translation CLI tool for i18n in web apps. It translates JSON, JS/TS,
Markdown files and database content using LLM providers (OpenAI, Mistral, Ollama).

Published to npm as `@speranto/speranto` and to JSR as `@speranto/speranto`.

## Build/Lint/Test Commands

Use Bun instead of Node.js for all tooling:

```bash
# Install dependencies
bun install

# Run all tests
bun test

# Run a single test file
bun test tests/translator.test.ts

# Run tests matching a pattern
bun test --filter "parseJSON"

# Build the package (uses tsdown)
bun run build

# Type check (no emit)
tsc --noEmit
```

Note: Tests require `LLM_API_KEY=test` environment variable, but `bun test` script sets this
automatically via package.json.

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

### Mocking

For LLM providers, use `MockLLMProvider` from `tests/mocks/LLMProvider.ts` to avoid
real API calls in tests.

## Project Structure

```
index.ts              # CLI entry point (Commander.js)
src/
├── config.ts         # Configuration types (exported to consumers)
├── translate.ts      # Main file translation orchestration
├── translate-database.ts  # Database translation orchestration
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
│   ├── openai.ts     # OpenAI provider
│   ├── mistral.ts    # Mistral provider
│   └── ollama.ts     # Ollama provider
├── parsers/
│   ├── json.ts       # JSON file parser
│   ├── js.ts         # JS/TS parser (Babel)
│   └── md.ts         # Markdown parser (Remark)
└── util/
    └── config.ts     # Config file loading utility
tests/
├── mocks/
│   ├── LLMProvider.ts    # Mock LLM provider
│   └── BunFile.ts
├── database/
│   ├── sqlite.test.ts
│   └── postgres.test.ts
├── parsers/
│   ├── json.test.ts
│   ├── js.test.ts
│   └── md.test.ts
├── translator.test.ts
├── translate.test.ts
├── providers.test.ts
└── docker-compose.yml    # PostgreSQL for database tests
```

## Architecture Notes

- `LLMInterface` is the abstract base class for all LLM providers (generate, isModelLoaded)
- `DatabaseAdapter` is the abstract base class for database backends
- Parsers extract translatable strings and reconstruct files after translation
- Translation is orchestrated via Listr2 for progress display
- Change detection avoids retranslating unchanged content (override with `retranslate: true`)
- `sequential` mode processes translations one at a time (for low rate-limit setups)
- Default provider is `mistral` with model `mistral-large-latest`
- CLI options override config file values; config loaded from `speranto.config.ts` or `.js`
