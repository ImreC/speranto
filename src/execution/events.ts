export interface ExecutionJob {
  id: string
  label: string
  source: 'file' | 'database'
  targetLang: string
}

export type ExecutionEvent =
  | { type: 'job-started'; job: ExecutionJob }
  | { type: 'job-completed'; job: ExecutionJob; durationMs: number }
  | { type: 'job-failed'; job: ExecutionJob; error: Error }
  | { type: 'scheduler-paused'; delayMs: number; attempt: number }

export interface ProgressReporter {
  handle(event: ExecutionEvent): void
  finish?(): void
}

export class ExecutionEvents {
  constructor(private reporter?: ProgressReporter) {}

  emit(event: ExecutionEvent): void {
    try {
      this.reporter?.handle(event)
    } catch {}
  }
}
