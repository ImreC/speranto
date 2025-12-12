# Speranto

A quick and simple machine translation tool for i18n in webapps. Named after Esperanto, the universal European language, Speranto helps you translate your content across multiple languages with ease.

## Installation

```bash
npm install @speranto/speranto
# or
yarn add @speranto/speranto
# or
pnpm add @speranto/speranto
# or
bun add @speranto/speranto
```

Also available on [JSR](https://jsr.io/@speranto/speranto):

```bash
npx jsr add @speranto/speranto
# or
deno add jsr:@speranto/speranto
```

## Usage

Run Speranto from your workspace directory:

```bash
speranto
```

### Configuration

**Creating a configuration file is strongly recommended.** Speranto will look for a configuration file in your workspace:
- `speranto.config.ts` (TypeScript, recommended)
- `speranto.config.js` (JavaScript)

#### Example Configuration

```typescript
// speranto.config.ts
import type { Config } from '@speranto/speranto'

const config: Config = {
  model: 'gpt-4o-mini',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['es', 'fr', 'de', 'it'],
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  files: {
    sourceDir: './content',
    targetDir: './content/[lang]',
    useLangCodeAsFilename: false,
    maxStringsPerGroup: 200,
  },
}

export default config
```

```javascript
// speranto.config.js
const config = {
  model: 'mistral-large-latest',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['nl'],
  provider: 'mistral',
  apiKey: process.env.MISTRAL_API_KEY,
  files: {
    sourceDir: './i18n/languages',
    targetDir: './i18n/languages',
    useLangCodeAsFilename: true,
  },
}

module.exports = config
```

#### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `model` | `string` | The AI model to use for translation |
| `temperature` | `number` | Temperature setting for the AI model (0.0 - 1.0) |
| `sourceLang` | `string` | Source language code (e.g., `'en'` for English) |
| `targetLangs` | `string[]` | Array of target language codes |
| `provider` | `string` | LLM provider: `'openai'`, `'ollama'`, or `'mistral'` |
| `apiKey` | `string` | API key for the LLM provider |
| `instructionsDir` | `string` | Directory containing language-specific instruction files (see below) |

#### File Translation Options (`files`)

| Option | Type | Description |
|--------|------|-------------|
| `sourceDir` | `string` | Directory containing source files |
| `targetDir` | `string` | Output directory pattern (use `[lang]` as placeholder) |
| `useLangCodeAsFilename` | `boolean` | Use language code as filename (e.g., `en.json` → `es.json`) |
| `maxStringsPerGroup` | `number` | Maximum strings per translation batch (helps with large files) |

### Language-Specific Instructions

You can provide custom translation instructions for each target language by creating markdown files in an instructions directory:

```
instructions/
├── es.md    # Spanish-specific instructions
├── fr.md    # French-specific instructions
└── nl.md    # Dutch-specific instructions
```

Then reference it in your config:

```typescript
const config: Config = {
  // ...
  instructionsDir: './instructions',
}
```

Example instruction file (`instructions/nl.md`):

```markdown
# Instructions for Dutch Translation

- Use informal "je/jij" instead of formal "u"
- Keep technical terms in English when commonly used
- Use short, direct sentences
```

### Command Line Options

You can override configuration with command line flags:

```bash
# Specify a custom config file
speranto --config ./custom-config.js

# Override specific options
speranto --model gpt-4o-mini --source-lang en --target-langs es,fr,de

# All available options
speranto \
  --config <path>              # Path to config file (default: ./speranto.config.ts)
  --model <model>              # Model to use for translation
  --temperature <number>       # Temperature for translation (0.0-1.0)
  --source-lang <lang>         # Source language code
  --target-langs <langs>       # Target language codes (comma-separated)
  --provider <provider>        # LLM provider (openai, ollama, mistral)
  --api-key <key>              # API key for LLM provider
  --instructions-dir <path>    # Directory containing language instruction files
  --verbose                    # Enable verbose output for debugging
```

## Database Translation

Speranto can also translate content stored in database tables. This is useful for CMS systems or applications that store translatable content in a database.

Simply add a `database` section to your config file alongside or instead of `files`:

```typescript
// speranto.config.ts
import type { Config } from '@speranto/speranto'

const config: Config = {
  model: 'gpt-4o-mini',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['es', 'fr', 'de'],
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  database: {
    type: 'postgres',  // 'sqlite' or 'postgres'
    connection: process.env.DATABASE_URL,
    tables: [
      {
        name: 'articles',
        columns: ['title', 'body', 'summary'],
        idColumn: 'id',  // optional, defaults to 'id'
      },
      {
        name: 'products',
        columns: ['name', 'description'],
      },
    ],
    translationTableSuffix: '_translations',  // optional, defaults to '_translations'
    concurrency: 10,  // optional, number of concurrent translations
  },
}

export default config
```

### SQLite Example

```typescript
const config: Config = {
  // ... other options
  database: {
    type: 'sqlite',
    connection: './data/content.db',
    tables: [
      {
        name: 'posts',
        columns: ['title', 'content'],
      },
    ],
  },
}
```

### Database Configuration Options (`database`)

| Option | Type | Description |
|--------|------|-------------|
| `type` | `string` | Database type: `'sqlite'` or `'postgres'` |
| `connection` | `string` | Connection string (file path for SQLite, URL for PostgreSQL) |
| `tables` | `array` | Array of tables to translate (see below) |
| `translationTableSuffix` | `string` | Suffix for translation tables (default: `'_translations'`) |
| `concurrency` | `number` | Number of concurrent row translations (default: `10`) |

#### Table Configuration

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Table name |
| `schema` | `string` | Schema name (PostgreSQL only, default: `'public'`) |
| `columns` | `string[]` | Array of column names to translate |
| `idColumn` | `string` | Primary key column (default: `'id'`) |

### How It Works

For each source table, Speranto creates a translation table (e.g., `articles_translations`) with the following structure:

| Column | Description |
|--------|-------------|
| `id` | Auto-incrementing primary key |
| `source_id` | Reference to the source row |
| `lang` | Target language code |
| `<column>` | Translated content for each specified column |
| `created_at` | Timestamp of creation |
| `updated_at` | Timestamp of last update |

Translations are upserted, so running the command multiple times will update existing translations rather than creating duplicates.

## Combining Files and Database

You can translate both files and database content in a single run by including both `files` and `database` in your config:

```typescript
const config: Config = {
  model: 'gpt-4o-mini',
  sourceLang: 'en',
  targetLangs: ['es', 'fr'],
  provider: 'openai',
  files: {
    sourceDir: './content',
    targetDir: './content/[lang]',
  },
  database: {
    type: 'postgres',
    connection: process.env.DATABASE_URL,
    tables: [{ name: 'posts', columns: ['title', 'body'] }],
  },
}
```