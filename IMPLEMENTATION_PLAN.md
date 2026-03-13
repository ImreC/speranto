# Speranto Translation Refactor Plan

## Goals

1. Make database translation tables the canonical read model for all languages, including the
   base language.
2. Support per-row source language for database records through an explicit `langColumn`
   configuration.
3. Replace existence-based change detection with hash-based change detection for both database
   translations and file translations.
4. Keep translation execution scoped to one `(sourceLang, targetLang)` pair at a time. Multi-target
   prompts are explicitly out of scope.

## Confirmed Decisions

- Database tables keep an explicit base language at the config level, but source rows may override
  it when `langColumn` is configured on a table.
- Translation tables will store the base-language entry as well as translated entries.
- Database change detection will use two layers:
  - row-level hash for fast skip
  - per-field hashes for partial retranslations
- File translation will use the same two-layer hash strategy, backed by a sidecar Speranto state
  store rather than embedding metadata into translated files.
- Translator instances will continue to map to a single `(sourceLang, targetLang)` pair and should
  be cached per pair.

## Implementation Steps

1. Add shared hashing utilities and metadata types for row-level and field-level change detection.
2. Extend DB config and types with explicit per-row language support (`langColumn`) and translation
   metadata fields.
3. Refactor database adapters to:
   - read per-row source language
   - add translation-table metadata columns
   - expose stored translation records instead of only translated IDs
4. Redesign DB orchestration around row-first processing with cached translators per
   `(sourceLang, targetLang)` pair.
5. Always upsert the base-language row into the translation table so translation tables become the
   canonical read model.
6. Implement hash-based DB change detection:
   - skip rows when the row hash matches
   - use per-field hashes to retranslate only changed fields
7. Add file-side hash state storage and use file/group-level hashes to skip unchanged files and
   retranslate only changed chunks/groups.
8. Handle existing translation tables with additive schema migration and treat rows missing hash
   metadata as stale for rebuild.
9. Add SQLite/Postgres tests for `langColumn`, base-language rows in translation tables, unchanged
   row skipping, and partial retranslations.
10. Update README and config examples to document canonical translation tables, per-row source
    language, and hash-based change detection for DB and files.
