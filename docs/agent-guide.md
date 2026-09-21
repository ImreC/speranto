# Speranto agent guide

This file describes how coding agents should work with Speranto in the project that installed
`@speranto/speranto`. It is managed by the package and replaced when Speranto is updated.

## Before making changes

- Look for `speranto.config.ts` or `speranto.config.js` in the project root.
- Treat files under the configured `files.sourceDir` as the canonical source-language content.
- Treat files under `files.targetDir` as generated translations unless the project explicitly
  says otherwise.
- Never add API keys or database connection strings to configuration committed to the
  repository. Use environment variables.
- Preserve project-specific instructions in `AGENTS.md`, `CLAUDE.md`, and the configured
  `instructionsDir`.

## Translation workflow

- Run `speranto` from the workspace containing the configuration file.
- Use `speranto --init` to build `.speranto/` state from existing source and target pairs
  without calling an LLM.
- Use `speranto --retranslate` only when the user explicitly wants every value translated
  again.
- Do not edit `.speranto/` state manually. Speranto uses it for hash-based change detection.
- Do not delete translated values merely because they were skipped in a run. Unchanged groups
  and fields are deliberately reused.
- Respect `excludeKeys`; excluded JSON and JavaScript/TypeScript values may be preserved from
  the existing target file.

## Language instructions

Speranto reads `<language>.md` files from `instructionsDir`, or from `./instructions` when the
option is omitted. Update these files when translation tone, terminology, formatting, or locale
rules change. Keep instructions specific to the target language.

## Configuration checks

- `sourceLang` identifies the canonical input language.
- `targetLangs` lists the generated languages.
- `concurrency` and `database.concurrency` must be positive integers. Use `1` for sequential
  work on rate-limited providers.
- Database translation tables use source-row and field hashes to avoid duplicate or unnecessary
  translations.
- Database translation rows are upserted by source identifier and language.

## Verification

After changing Speranto configuration or translation inputs:

1. Run the project-specific checks documented in its `AGENTS.md` or `CLAUDE.md`.
2. Run `speranto --init` if adopting existing translations, otherwise run `speranto` only when
   the required provider credentials are available and the user expects LLM calls.
3. Review generated translations and confirm that placeholders, Markdown structure, and
   excluded values were preserved.

For the complete configuration and CLI reference, read the installed package `README.md`.
