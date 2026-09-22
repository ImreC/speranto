import { LLMInterface, type LLMGenerateOptions, type LLMResponse } from './llm.interface'
import { RequestScheduler } from '../execution/scheduler'
import type { ExecutionJob } from '../execution/events'

export class ScheduledLLM extends LLMInterface {
  constructor(
    model: string,
    private inner: LLMInterface,
    private scheduler: RequestScheduler,
    private job: ExecutionJob,
  ) {
    super(model)
  }

  generate(prompt: string, options?: LLMGenerateOptions): Promise<LLMResponse> {
    const job = options?.executionJob ?? (options?.executionLabel
      ? {
          ...this.job,
          id: `${this.job.id}:${options.executionLabel}`,
          label: options.executionLabel,
          kind: 'translation' as const,
        }
      : this.job)
    return this.scheduler.run({ ...job, kind: 'request' }, () =>
      this.inner.generate(prompt, options),
    )
  }

  isModelLoaded(): Promise<boolean> {
    return this.scheduler.run(this.job, () => this.inner.isModelLoaded())
  }
}
