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