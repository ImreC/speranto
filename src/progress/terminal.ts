import type { WriteStream } from 'node:tty'
import type { ExecutionEvent, ProgressReporter } from '../execution/events'
import {
  ProgressTracker,
  type ProgressRenderer,
  type ProgressSnapshot,
} from './tracker'

export class TerminalProgressReporter implements ProgressReporter {
  private tracker: ProgressTracker

  constructor(stream: WriteStream = process.stdout) {
    const renderer = stream.isTTY
      ? new InteractiveProgressRenderer(stream)
      : new PlainProgressRenderer(stream)
    this.tracker = new ProgressTracker(renderer)
  }

  handle(event: ExecutionEvent): void {
    this.tracker.handle(event)
  }

  finish(): void {
    this.tracker.finish()
  }
}

class InteractiveProgressRenderer implements ProgressRenderer {
  private renderedLines = 0

  constructor(private stream: WriteStream) {}

  render(snapshot: ProgressSnapshot, event: ExecutionEvent): void {
    if (event.type === 'job-started' && snapshot.active.length > 3) return
    this.redraw(buildDashboard(snapshot))
  }

  finish(snapshot: ProgressSnapshot): void {
    this.redraw(buildDashboard(snapshot))
    this.stream.write('\n')
    this.renderedLines = 0
  }

  private redraw(lines: string[]): void {
    if (this.renderedLines > 0) this.stream.write(`\u001B[${this.renderedLines}F\u001B[J`)
    this.stream.write(`${lines.join('\n')}\n`)
    this.renderedLines = lines.length
  }
}

class PlainProgressRenderer implements ProgressRenderer {
  private lastSnapshotAt = 0
  private completedLanguages = new Set<string>()

  constructor(private stream: WriteStream) {}

  render(snapshot: ProgressSnapshot, event: ExecutionEvent): void {
    if (event.type === 'planning-started') {
      this.write(`[plan] Inspecting work for ${event.sourceLanguages} language(s)`)
    } else if (event.type === 'planning-completed') {
      this.write(`[plan] ${formatPlan(snapshot)}`)
      this.reportCompletedLanguages(snapshot)
    } else if (event.type === 'scheduler-paused') {
      this.write(`[rate-limit] Pausing new requests for ${formatDuration(event.delayMs)}`)
    } else if (event.type === 'job-failed' && event.job.kind !== 'request') {
      this.write(`[failed] ${formatJob(event.job)}: ${event.error.message}`)
    } else if (event.type === 'run-completed') {
      this.write(`[done] ${formatSummary(snapshot)}`)
    } else if (event.type === 'job-completed') {
      this.reportCompletedLanguages(snapshot)
      const now = Date.now()
      if (now - this.lastSnapshotAt >= 10_000) {
        this.write(`[progress] ${formatProgress(snapshot)}`)
        this.lastSnapshotAt = now
      }
    }
  }

  private reportCompletedLanguages(snapshot: ProgressSnapshot): void {
    for (const [language, progress] of Object.entries(snapshot.languages)) {
      if (this.completedLanguages.has(language)) continue
      if (progress.completed + progress.failed < progress.pending) continue
      this.completedLanguages.add(language)
      this.write(
        `[${language}] ${progress.completed}/${progress.pending} jobs, ` +
          `${progress.reused} reused, ${progress.failed} failed`,
      )
    }
  }

  private write(message: string): void {
    this.stream.write(`${message}\n`)
  }
}

function buildDashboard(snapshot: ProgressSnapshot): string[] {
  const elapsed = formatDuration(Date.now() - snapshot.startedAt)
  const lines = ['Speranto', '']

  if (snapshot.phase === 'planning') {
    lines.push('Planning translation…')
    lines.push(
      `  ${snapshot.files} file target(s) · ${snapshot.tables} table target(s) · ` +
        `${snapshot.planned} jobs discovered`,
    )
    return lines
  }

  const finished = snapshot.completed + snapshot.failed
  const percent =
    snapshot.pending === 0 ? 100 : Math.floor((finished / snapshot.pending) * 100)
  lines.push(
    `Overall  ${finished}/${snapshot.pending} jobs  ${percent}% · ` +
      `${snapshot.active.length} active · ${snapshot.failed} failed · ${elapsed}`,
  )
  lines.push(
    `Files    ${snapshot.committedFiles}/${snapshot.pendingFiles} written · ` +
      `${snapshot.files} target(s) · ${snapshot.fileReused} reused`,
  )
  if (snapshot.tables > 0) {
    lines.push(
      `Database ${snapshot.rows} rows · ${snapshot.tables} table target(s) · ` +
        `${snapshot.databaseReused} reused`,
    )
  }
  lines.push('', 'Languages')

  for (const [language, progress] of Object.entries(snapshot.languages)) {
    const done = progress.completed + progress.failed
    const marker = progress.pending > 0 && done >= progress.pending ? '✓' : '●'
    lines.push(
      `  ${language.padEnd(5)} ${marker} ${done}/${progress.pending} jobs · ` +
        `${progress.committedFiles} file(s) · ${progress.reused} reused`,
    )
  }

  if (snapshot.active.length > 0) {
    lines.push('', 'Currently translating')
    for (const job of snapshot.active.slice(0, 3)) lines.push(`  ${formatJob(job)}`)
    if (snapshot.active.length > 3) lines.push(`  +${snapshot.active.length - 3} more`)
  }
  if (snapshot.retries > 0) lines.push('', `Rate-limit pauses: ${snapshot.retries}`)
  if ((snapshot.summary?.operationFailures ?? 0) > 0) {
    lines.push('', `Operation failures: ${snapshot.summary!.operationFailures}`)
  }
  return lines
}

function formatPlan(snapshot: ProgressSnapshot): string {
  let summary =
    `${snapshot.files} file target(s), ${snapshot.tables} table target(s), ` +
    `${snapshot.pending} pending jobs, ${snapshot.reused} reused`
  if (snapshot.rows > 0) summary += `, ${snapshot.rows} database rows`
  return summary
}

function formatProgress(snapshot: ProgressSnapshot): string {
  return (
    `${snapshot.completed + snapshot.failed}/${snapshot.pending} jobs, ` +
    `${snapshot.committedFiles}/${snapshot.pendingFiles} files, ` +
    `${snapshot.active.length} active`
  )
}

function formatSummary(snapshot: ProgressSnapshot): string {
  const duration = snapshot.summary?.durationMs ?? Date.now() - snapshot.startedAt
  let summary =
    `${snapshot.completed} translated, ${snapshot.reused} reused, ` +
    `${snapshot.failed} failed, ${snapshot.committedFiles} files written in ` +
    formatDuration(duration)
  if ((snapshot.summary?.operationFailures ?? 0) > 0) {
    summary += `, ${snapshot.summary!.operationFailures} operation failure(s)`
  }
  return summary
}

function formatJob(job: { targetLang: string; label: string }): string {
  return `${job.targetLang}  ${job.label}`
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
