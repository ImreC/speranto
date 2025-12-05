# Speranto

A quick and simple machine translation tool for i18n in webapps. Named after Esperanto, the universal European language, Speranto helps you translate your content across multiple languages with ease.

## Installation

```bash
npm install -g @speranto/speranto
# or
yarn global add @speranto/speranto
# or
pnpm add -g @speranto/speranto
# or
bun add -g @speranto/speranto
```

## Usage

Run Speranto from your workspace directory:

```bash
speranto
```

### Configuration

Speranto will look for a configuration file in your workspace:
- `speranto.config.ts` (TypeScript)
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
  sourceDir: './content',
  targetDir: './content/[lang]',
  provider: 'openai',
  useLangCodeAsFilename: false
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
  sourceDir: './example_content/content/blog/en',
  targetDir: './example_content/content/blog/[lang]',
  provider: 'mistral',
  apiKey: process.env.MISTRAL_API_KEY,
}

module.exports = config
```

#### Configuration Options

- `model`: The AI model to use for translation
- `temperature`: Temperature setting for the AI model (0.0 - 1.0)
- `sourceLang`: Source language code (e.g., 'en' for English)
- `targetLangs`: Array of target language codes
- `sourceDir`: Directory containing source files
- `targetDir`: Output directory pattern (use `[lang]` as placeholder for language code)
- `provider`: LLM provider ('openai', 'ollama', or 'mistral')
- `useLangCodeAsFilename`: Use language code as filename instead of original names

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
  --source-dir <dir>           # Source directory path
  --target-dir <dir>           # Target directory path (use [lang] placeholder)
  --provider <provider>        # LLM provider (openai, ollama, mistral)
  --use-lang-code-as-filename  # Use language code as filename
```

## Examples

### Basic Translation

Translate English content to Spanish:

```bash
speranto --source-lang en --target-langs es
```

### Multiple Languages

Translate to multiple languages at once:

```bash
speranto --source-lang en --target-langs es,fr,de,it,pt
```

### Custom Directories

Specify custom source and target directories:

```bash
speranto --source-dir ./docs --target-dir ./locales/[lang]/docs
```

## Database Translation

Speranto can also translate content stored in database tables. This is useful for CMS systems or applications that store translatable content in a database.

### Database Command

```bash
speranto db --config ./speranto.db.config.ts
```

### Database Configuration

Create a configuration file with database settings:

```typescript
// speranto.db.config.ts
import type { DatabaseTranslationConfig } from '@speranto/speranto'

const config: DatabaseTranslationConfig = {
  model: 'gpt-4o-mini',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['es', 'fr', 'de'],
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  database: {
    type: 'postgres',  // 'sqlite' or 'postgres'
    connection: 'postgresql://user:password@localhost:5432/mydb',
    tables: [
      {
        name: 'articles',
        columns: ['title', 'body', 'summary'],
        idColumn: 'id'  // optional, defaults to 'id'
      },
      {
        name: 'products',
        columns: ['name', 'description']
      }
    ],
    translationTableSuffix: '_translations'  // optional, defaults to '_translations'
  }
}

export default config
```

### SQLite Example

```typescript
const config = {
  // ... other options
  database: {
    type: 'sqlite',
    connection: './data/content.db',
    tables: [
      {
        name: 'posts',
        columns: ['title', 'content']
      }
    ]
  }
}
```

### Database Configuration Options

- `database.type`: Database type (`'sqlite'` or `'postgres'`)
- `database.connection`: Connection string
  - SQLite: path to the database file (e.g., `'./data.db'`)
  - PostgreSQL: connection URL (e.g., `'postgresql://user:pass@host:5432/db'`)
- `database.tables`: Array of tables to translate
  - `name`: Table name
  - `columns`: Array of column names to translate
  - `idColumn`: Primary key column (optional, defaults to `'id'`)
- `database.translationTableSuffix`: Suffix for translation tables (optional, defaults to `'_translations'`)

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

### Database CLI Options

```bash
speranto db \
  --config <path>              # Path to config file (required)
  --model <model>              # Override model from config
  --temperature <number>       # Override temperature
  --source-lang <lang>         # Override source language
  --target-langs <langs>       # Override target languages (comma-separated)
  --provider <provider>        # Override LLM provider
  --api-key <key>              # Override API key
```