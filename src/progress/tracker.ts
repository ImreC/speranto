import type {
  ExecutionEvent,
  ExecutionJob,
  ProgressReporter,
  RunSummary,
  WorkSource,
} from '../execution/events'

export interface LanguageProgress {
  planned: number
  pending: number
  reused: number
  completed: number
  failed: number
  committedFiles: number
}

export interface ProgressSnapshot {
  phase: 'planning' | 'translating' | 'complete'
  startedAt: number
  sourceLanguages: number
  dryRun: boolean
  scopes: number
  files: number
  pendingFiles: number
  tables: number
  rows: number
  planned: number
  pending: number
  reused: number
  estimatedTokens: number
  fileReused: number
  databaseReused: number
  completed: number
  failed: number
  active: ExecutionJob[]
  retries: number
  committedFiles: number
  languages: Record<string, LanguageProgress>
  summary?: RunSummary
}

export interface ProgressRenderer {
  render(snapshot: ProgressSnapshot, event: ExecutionEvent): void
  finish?(snapshot: ProgressSnapshot): void
}

export class ProgressTracker implements ProgressReporter {
  private activeJobs = new Map<string, ExecutionJob>()
  private snapshot: ProgressSnapshot = {
    phase: 'planning',
    startedAt: Date.now(),
    sourceLanguages: 0,
    dryRun: false,
    scopes: 0,
    files: 0,
    pendingFiles: 0,
    tables: 0,
    rows: 0,
    planned: 0,
    pending: 0,
    reused: 0,
    estimatedTokens: 0,
    fileReused: 0,
    databaseReused: 0,
    completed: 0,
    failed: 0,
    active: [],
    retries: 0,
    committedFiles: 0,
    languages: {},
  }

  constructor(private renderer: ProgressRenderer) {}

  handle(event: ExecutionEvent): void {
    if (event.type === 'planning-started') {
      this.snapshot.sourceLanguages = event.sourceLanguages
      this.snapshot.dryRun = event.dryRun ?? false
    } else if (event.type === 'scope-planned') {
      const { scope } = event
      this.snapshot.scopes++
      this.snapshot.planned += scope.jobs
      this.snapshot.pending += scope.pending
      this.snapshot.reused += scope.reused
      this.snapshot.estimatedTokens += scope.estimatedTokens ?? 0
      if (scope.source === 'file') this.snapshot.fileReused += scope.reused
      else this.snapshot.databaseReused += scope.reused
      this.snapshot.rows += scope.rows ?? 0
      if (scope.writesFile) this.snapshot.pendingFiles++
      this.incrementSource(scope.source)
      const language = this.getLanguage(scope.targetLang)
      language.planned += scope.jobs
      language.pending += scope.pending
      language.reused += scope.reused
    } else if (event.type === 'planning-completed') {
      this.snapshot.phase = 'translating'
    } else if (event.type === 'job-started' && event.job.kind === 'translation') {
      this.activeJobs.set(event.job.id, event.job)
    } else if (event.type === 'job-completed' && event.job.kind === 'translation') {
      this.activeJobs.delete(event.job.id)
      this.snapshot.completed++
      this.getLanguage(event.job.targetLang).completed++
    } else if (event.type === 'job-failed' && event.job.kind === 'translation') {
      this.activeJobs.delete(event.job.id)
      this.snapshot.failed++
      this.getLanguage(event.job.targetLang).failed++
    } else if (event.type === 'file-committed') {
      this.snapshot.committedFiles++
      this.getLanguage(event.targetLang).committedFiles++
    } else if (event.type === 'scheduler-paused') {
      this.snapshot.retries++
    } else if (event.type === 'run-completed') {
      if (!event.summary.dryRun) {
        for (const language of Object.values(this.snapshot.languages)) {
          const unfinished = language.pending - language.completed - language.failed
          if (unfinished > 0) {
            language.failed += unfinished
            this.snapshot.failed += unfinished
          }
        }
      }
      this.snapshot.phase = 'complete'
      this.snapshot.summary = event.summary
    }

    this.snapshot.active = Array.from(this.activeJobs.values())
    this.renderer.render(this.snapshot, event)
  }

  finish(): void {
    this.renderer.finish?.(this.snapshot)
  }

  private incrementSource(source: WorkSource): void {
    if (source === 'file') this.snapshot.files++
    else this.snapshot.tables++
  }

  private getLanguage(targetLang: string): LanguageProgress {
    this.snapshot.languages[targetLang] ??= {
      planned: 0,
      pending: 0,
      reused: 0,
      completed: 0,
      failed: 0,
      committedFiles: 0,
    }
    return this.snapshot.languages[targetLang]
  }
}
