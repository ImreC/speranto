export function resolveConcurrency(
  value: number | undefined,
  fallback: number,
  optionName: string,
): number {
  const concurrency = value ?? fallback
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`${optionName} must be a positive integer`)
  }
  return concurrency
}
