---

Speranto is a machine translation CLI tool for i18n. It translates JSON, JS/TS, Markdown files
and database content using LLM providers (OpenAI, Mistral, Ollama).

## Tooling

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun run build` to build with tsdown
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

**Important:** This package is published to npm and jsr as a universal Node-compatible package. Use Node.js APIs (`node:fs`, `node:path`, etc.) in runtime code, not Bun-specific APIs like `Bun.file` or `Bun.write`.

- `node:fs/promises` for file operations (readFile, writeFile, etc.)
- `node:path` for path operations

Bun-specific APIs are fine for:
- Build scripts
- Test files
- Development tooling

## Testing

Use `bun test` to run tests. The `LLM_API_KEY=test` env var is set automatically via the package.json script.

```ts
import { test, expect } from "bun:test";
```

## Important general instructions:

- Only write comments if there is really no other way. Prefer good code splitting and clear function names
