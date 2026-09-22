export type WorkSource = 'file' | 'database'

export interface ExecutionJob {
  id: string
  label: string
  source: WorkSource
  targetLang: string
  kind: 'translation' | 'request' | 'setup'
  file?: string
  group?: string
  table?: string
  rowId?: string
}

export interface PlannedScope {
  id: string
  label: string
  source: WorkSource
  targetLang: string
  jobs: number
  pending: number
  reused: number
  rows?: number
  writesFile?: boolean
}

export interface RunSummary {
  durationMs: number
  operationFailures: number
}

export type ExecutionEvent =
  | { type: 'planning-started'; sourceLanguages: number }
  | { type: 'scope-planned'; scope: PlannedScope }
  | { type: 'planning-completed' }
  | { type: 'job-started'; job: ExecutionJob }
  | { type: 'job-completed'; job: ExecutionJob; durationMs: number }
  | { type: 'job-failed'; job: ExecutionJob; error: Error }
  | { type: 'file-committed'; targetLang: string; file: string }
  | { type: 'scheduler-paused'; delayMs: number; attempt: number }
  | { type: 'run-completed'; summary: RunSummary }

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
