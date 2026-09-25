import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedCandles, findNextMissingRange } from './historicalData'

test('selects the real internal gap instead of using the absolute oldest candle', () => {
  const result = findNextMissingRange({ missingRanges: [
    { start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T00:05:00.000Z' },
    { start: '2026-09-10T00:05:00.000Z', end: '2026-09-20T00:00:00.000Z' },
  ] }, '2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z', '5min')
  assert.ok(result)
  assert.ok(Date.parse(result.start) > Date.parse('2026-09-10T00:05:00.000Z'))
  assert.ok(Date.parse(result.end) < Date.parse('2026-09-20T00:00:00.000Z'))
})

test('expected candle denominator is stable for identical normalized inputs', () => {
  const start = '2026-09-01T00:00:00.000Z'
  const end = '2026-09-30T23:59:59.999Z'
  assert.equal(expectedCandles(start, end, '5min'), expectedCandles(start, end, '5min'))
  assert.equal(expectedCandles(start, end, '5min'), 6336)
})

test('weekend-only gap is classified as market closed', () => {
  const result = findNextMissingRange({ missingRanges: [{ start: '2026-09-26T00:00:00.000Z', end: '2026-09-28T00:00:00.000Z' }] }, '2026-09-26T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '5min')
  assert.equal(result?.marketClosed, true)
})
