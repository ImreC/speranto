import type { ExecutionEvent, ProgressReporter } from '../execution/events'

export class TerminalProgressReporter implements ProgressReporter {
  private completed = 0
  private failed = 0

  handle(event: ExecutionEvent): void {
    if (event.type === 'job-completed') {
      this.completed++
      const failures = this.failed > 0 ? `, ${this.failed} failed` : ''
      process.stdout.write(`\rTranslated ${this.completed} request(s)${failures}`)
    } else if (event.type === 'job-failed') {
      this.failed++
      process.stdout.write(`\rTranslated ${this.completed} request(s), ${this.failed} failed`)
    } else if (event.type === 'scheduler-paused') {
      const seconds = Math.ceil(event.delayMs / 1000)
      process.stdout.write(`\nRate limited; pausing new requests for ${seconds}s\n`)
    }
  }

  finish(): void {
    if (this.completed > 0 || this.failed > 0) process.stdout.write('\n')
  }
}
