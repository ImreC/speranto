import { expect, test } from 'vitest'
import {
  ExecutionEvents,
  type ExecutionEvent,
  type ProgressReporter,
} from '../../src/execution/events'
import { RequestScheduler } from '../../src/execution/scheduler'

class RecordingReporter implements ProgressReporter {
  events: ExecutionEvent[] = []

  handle(event: ExecutionEvent): void {
    this.events.push(event)
  }
}

test('request scheduler enforces one global concurrency limit', async () => {
  const reporter = new RecordingReporter()
  const scheduler = new RequestScheduler(2, new ExecutionEvents(reporter))
  let active = 0
  let maximumActive = 0

  const requests = Array.from({ length: 8 }, (_, index) =>
    scheduler.run(
      {
        id: `job-${index}`,
        label: `Job ${index}`,
        source: 'file',
        targetLang: index % 2 === 0 ? 'es' : 'fr',
        kind: 'translation',
      },
      async () => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return index
      },
    ),
  )

  await expect(Promise.all(requests)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(maximumActive).toBe(2)
  expect(reporter.events.filter((event) => event.type === 'job-completed')).toHaveLength(8)
})

test('progress reporter failures do not fail scheduled work', async () => {
  const scheduler = new RequestScheduler(
    1,
    new ExecutionEvents({
      handle: () => {
        throw new Error('renderer failed')
      },
    }),
  )

  await expect(
    scheduler.run(
      { id: 'job', label: 'Job', source: 'file', targetLang: 'es', kind: 'translation' },
      async () => 'completed',
    ),
  ).resolves.toBe('completed')
})

test('aborting the scheduler rejects work that has not started', async () => {
  const scheduler = new RequestScheduler(1, new ExecutionEvents())
  let releaseFirst!: () => void
  const first = scheduler.run(
    {
      id: 'first',
      label: 'First',
      source: 'file',
      targetLang: 'es',
      kind: 'translation',
    },
    () => new Promise<void>((resolve) => (releaseFirst = resolve)),
  )
  const second = scheduler.run(
    {
      id: 'second',
      label: 'Second',
      source: 'file',
      targetLang: 'fr',
      kind: 'translation',
    },
    async () => undefined,
  )
  const secondResult = second.catch((error: unknown) => error)

  scheduler.abort(new Error('invalid credentials'))
  releaseFirst()

  await expect(first).resolves.toBeUndefined()
  expect(await secondResult).toEqual(new Error('invalid credentials'))
})
