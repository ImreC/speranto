const isTTY = process.stderr.isTTY ?? false

const ANSI = {
  clearLine: '\x1b[2K',
  cursorUp: (n: number) => `\x1b[${n}A`,
  cursorStart: '\r',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
}

function progressBar(current: number, total: number, width = 20): string {
  const filled = Math.round((current / total) * width)
  const empty = width - filled
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty)
}

export interface LanguageProgress {
  lang: string
  total: number
  completed: number
  errors: number
}

export class ProgressReporter {
  private version: string
  private currentLang: LanguageProgress | null = null
  private completedLangs: LanguageProgress[] = []
  private errors: Array<{ lang: string; group: string; error: string }> = []
  private lastLineCount = 0

  constructor(version: string) {
    this.version = version
  }

  header(sourceLang: string, targetLangs: string[], fileCount: number) {
    const langs = targetLangs.join(', ')
    this.write(
      `${ANSI.bold}Speranto v${this.version}${ANSI.reset} ${ANSI.dim}\u2014 translating ${fileCount} file${fileCount !== 1 ? 's' : ''} from ${sourceLang} \u2192 ${langs}${ANSI.reset}\n`,
    )
  }

  databaseHeader(sourceLang: string, targetLangs: string[], tableCount: number) {
    const langs = targetLangs.join(', ')
    this.write(
      `${ANSI.bold}Speranto v${this.version}${ANSI.reset} ${ANSI.dim}\u2014 translating ${tableCount} table${tableCount !== 1 ? 's' : ''} from ${sourceLang} \u2192 ${langs}${ANSI.reset}\n`,
    )
  }

  startLanguage(lang: string, totalGroups: number) {
    this.currentLang = { lang, total: totalGroups, completed: 0, errors: 0 }
    this.render()
  }

  updateProgress() {
    if (this.currentLang) {
      this.currentLang.completed++
      this.render()
    }
  }

  reportError(lang: string, group: string, error: string) {
    if (this.currentLang) this.currentLang.errors++
    this.errors.push({ lang, group, error })
  }

  finishLanguage() {
    if (this.currentLang) {
      this.completedLangs.push({ ...this.currentLang })
      this.currentLang = null
      this.render()
    }
  }

  skipLanguage(lang: string, reason: string) {
    this.completedLangs.push({ lang, total: 0, completed: 0, errors: 0 })
    if (isTTY) {
      this.clearLines()
    }
    this.write(`  ${ANSI.dim}${lang}  ${reason}${ANSI.reset}\n`)
    this.lastLineCount = 0
  }

  finish() {
    if (isTTY) this.clearLines()

    for (const lang of this.completedLangs) {
      if (lang.total === 0) {
        this.write(`  ${ANSI.dim}${lang.lang}  nothing to translate${ANSI.reset}\n`)
      } else if (lang.errors > 0) {
        this.write(
          `  ${ANSI.yellow}${lang.lang}${ANSI.reset}  ${lang.completed}/${lang.total} groups (${lang.errors} error${lang.errors !== 1 ? 's' : ''})\n`,
        )
      } else {
        this.write(
          `  ${ANSI.green}${lang.lang}${ANSI.reset}  ${lang.completed}/${lang.total} groups ${ANSI.green}\u2713${ANSI.reset}\n`,
        )
      }
    }

    if (this.errors.length > 0) {
      this.write(`\n${ANSI.red}Errors:${ANSI.reset}\n`)
      for (const err of this.errors) {
        this.write(`  ${ANSI.red}[${err.lang}] ${err.group}:${ANSI.reset} ${err.error}\n`)
      }
    }

    this.write('\n')
  }

  private render() {
    if (!isTTY) {
      if (this.currentLang) {
        const { lang, completed, total } = this.currentLang
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0
        this.write(`  ${lang}  ${completed}/${total} groups (${pct}%)\n`)
      }
      return
    }

    this.clearLines()

    const lines: string[] = []

    for (const lang of this.completedLangs) {
      if (lang.total === 0) {
        lines.push(`  ${ANSI.dim}${lang.lang}  nothing to translate${ANSI.reset}`)
      } else if (lang.errors > 0) {
        lines.push(
          `  ${ANSI.yellow}${lang.lang}${ANSI.reset}  ${lang.completed}/${lang.total} groups (${lang.errors} error${lang.errors !== 1 ? 's' : ''})`,
        )
      } else {
        lines.push(
          `  ${ANSI.green}${lang.lang}${ANSI.reset}  ${lang.completed}/${lang.total} groups ${ANSI.green}\u2713${ANSI.reset}`,
        )
      }
    }

    if (this.currentLang) {
      const { lang, completed, total } = this.currentLang
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0
      lines.push(
        `  ${ANSI.bold}${lang}${ANSI.reset}  ${progressBar(completed, total)}  ${completed}/${total} groups (${pct}%)`,
      )
    }

    const output = lines.join('\n') + '\n'
    process.stderr.write(output)
    this.lastLineCount = lines.length
  }

  private clearLines() {
    if (this.lastLineCount > 0) {
      process.stderr.write(
        ANSI.cursorUp(this.lastLineCount) +
          (ANSI.cursorStart + ANSI.clearLine + '\n').repeat(this.lastLineCount) +
          ANSI.cursorUp(this.lastLineCount),
      )
    }
  }

  private write(text: string) {
    process.stderr.write(text)
  }
}
