import { ExecutionEvents, type ExecutionJob } from './events'

interface PendingRequest<T> {
  job: ExecutionJob
  operation: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export class RequestScheduler {
  private active = 0
  private cooldownUntil = 0
  private cooldownTimer?: ReturnType<typeof setTimeout>
  private queue: Array<PendingRequest<unknown>> = []
  private abortedError?: Error

  constructor(
    private concurrency: number,
    private events: ExecutionEvents,
  ) {}

  run<T>(job: ExecutionJob, operation: () => Promise<T>): Promise<T> {
    if (this.abortedError) {
      this.events.emit({ type: 'job-failed', job, error: this.abortedError })
      return Promise.reject(this.abortedError)
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        job,
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.drain()
    })
  }

  abort(error: Error): void {
    if (this.abortedError) return

    this.abortedError = error
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer)
    for (const request of this.queue.splice(0)) {
      this.events.emit({ type: 'job-failed', job: request.job, error })
      request.reject(error)
    }
  }

  pause(delayMs: number, attempt: number): void {
    const nextCooldown = Date.now() + delayMs
    if (nextCooldown <= this.cooldownUntil) return

    this.cooldownUntil = nextCooldown
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer)
    this.events.emit({ type: 'scheduler-paused', delayMs, attempt })
    this.cooldownTimer = setTimeout(() => this.drain(), delayMs)
  }

  private drain(): void {
    if (this.abortedError) return
    if (Date.now() < this.cooldownUntil) return

    while (this.active < this.concurrency && this.queue.length > 0) {
      const request = this.queue.shift()!
      this.active++
      const startedAt = Date.now()
      this.events.emit({ type: 'job-started', job: request.job })

      request
        .operation()
        .then((value) => {
          this.events.emit({
            type: 'job-completed',
            job: request.job,
            durationMs: Date.now() - startedAt,
          })
          request.resolve(value)
        })
        .catch((error: unknown) => {
          const normalizedError = error instanceof Error ? error : new Error(String(error))
          this.events.emit({ type: 'job-failed', job: request.job, error: normalizedError })
          request.reject(normalizedError)
        })
        .finally(() => {
          this.active--
          this.drain()
        })
    }
  }
}
