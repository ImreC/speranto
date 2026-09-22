import { expect, test } from 'vitest'
import { resolveConcurrency } from '../../src/util/concurrency'

test('resolveConcurrency should use the fallback when no value is configured', () => {
  expect(resolveConcurrency(undefined, 5, 'concurrency')).toBe(5)
})

test('resolveConcurrency should reject non-positive and fractional values', () => {
  expect(() => resolveConcurrency(0, 5, 'concurrency')).toThrow(
    'concurrency must be a positive integer',
  )
  expect(() => resolveConcurrency(-1, 5, 'concurrency')).toThrow(
    'concurrency must be a positive integer',
  )
  expect(() => resolveConcurrency(1.5, 5, 'concurrency')).toThrow(
    'concurrency must be a positive integer',
  )
})
