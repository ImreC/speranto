import type { WriteStream } from 'node:tty'
import { expect, test } from 'vitest'
import {
  ProgressTracker,
  type ProgressRenderer,
  type ProgressSnapshot,
} from '../../src/progress/tracker'
import type { ExecutionEvent } from '../../src/execution/events'
import { TerminalProgressReporter } from '../../src/progress/terminal'

class RecordingRenderer implements ProgressRenderer {
  snapshots: ProgressSnapshot[] = []

  render(snapshot: ProgressSnapshot): void {
    this.snapshots.push(structuredClone(snapshot))
  }
}

test('progress tracker reports planning, languages, active work, reuse, and commits', () => {
  const renderer = new RecordingRenderer()
  const tracker = new ProgressTracker(renderer)
  const events: ExecutionEvent[] = [
    { type: 'planning-started', sourceLanguages: 2 },
    {
      type: 'scope-planned',
      scope: {
        id: 'file:es:checkout.json',
        label: 'checkout.json',
        source: 'file',
        targetLang: 'es',
        jobs: 3,
        pending: 2,
        reused: 1,
        writesFile: true,
      },
    },
    {
      type: 'scope-planned',
      scope: {
        id: 'file:fr:checkout.json',
        label: 'checkout.json',
        source: 'file',
        targetLang: 'fr',
        jobs: 3,
        pending: 0,
        reused: 3,
      },
    },
    { type: 'planning-completed' },
    {
      type: 'job-started',
      job: {
        id: 'job-1',
        label: 'checkout.json › payment',
        source: 'file',
        targetLang: 'es',
        kind: 'translation',
      },
    },
    {
      type: 'job-completed',
      job: {
        id: 'job-1',
        label: 'checkout.json › payment',
        source: 'file',
        targetLang: 'es',
        kind: 'translation',
      },
      durationMs: 10,
    },
    { type: 'file-committed', targetLang: 'es', file: 'checkout.json' },
    { type: 'run-completed', summary: { durationMs: 20, operationFailures: 0 } },
  ]

  for (const event of events) tracker.handle(event)

  const snapshot = renderer.snapshots.at(-1)!
  expect(snapshot.phase).toBe('complete')
  expect(snapshot.files).toBe(2)
  expect(snapshot.pendingFiles).toBe(1)
  expect(snapshot.pending).toBe(2)
  expect(snapshot.reused).toBe(4)
  expect(snapshot.completed).toBe(1)
  expect(snapshot.committedFiles).toBe(1)
  expect(snapshot.languages.es).toMatchObject({ pending: 2, completed: 1 })
  expect(snapshot.languages.fr).toMatchObject({ pending: 0, reused: 3 })
  expect(snapshot.active).toHaveLength(0)
})

test('progress tracker excludes setup requests from translation totals', () => {
  const renderer = new RecordingRenderer()
  const tracker = new ProgressTracker(renderer)
  const setupJob = {
    id: 'setup',
    label: 'Load model',
    source: 'file' as const,
    targetLang: 'es',
    kind: 'setup' as const,
  }

  tracker.handle({ type: 'job-started', job: setupJob })
  tracker.handle({ type: 'job-completed', job: setupJob, durationMs: 10 })

  const snapshot = renderer.snapshots.at(-1)!
  expect(snapshot.completed).toBe(0)
  expect(snapshot.active).toHaveLength(0)
})

test('plain progress output includes planning, languages, failures, and final summary', () => {
  let output = ''
  const stream = {
    isTTY: false,
    write: (chunk: string) => {
      output += chunk
      return true
    },
  } as unknown as WriteStream
  const reporter = new TerminalProgressReporter(stream)

  reporter.handle({ type: 'planning-started', sourceLanguages: 1 })
  reporter.handle({
    type: 'scope-planned',
    scope: {
      id: 'file:es:checkout.json',
      label: 'checkout.json',
      source: 'file',
      targetLang: 'es',
      jobs: 2,
      pending: 1,
      reused: 1,
      writesFile: true,
    },
  })
  reporter.handle({ type: 'planning-completed' })
  reporter.handle({
    type: 'job-failed',
    job: {
      id: 'job',
      label: 'checkout.json › checkout',
      source: 'file',
      targetLang: 'es',
      kind: 'translation',
    },
    error: new Error('provider unavailable'),
  })
  reporter.handle({
    type: 'run-completed',
    summary: { durationMs: 1_000, operationFailures: 1 },
  })

  expect(output).toContain('[plan] 1 file target(s)')
  expect(output).toContain('[failed] es  checkout.json › checkout: provider unavailable')
  expect(output).toContain('[done] 0 translated, 1 reused, 1 failed')
})
