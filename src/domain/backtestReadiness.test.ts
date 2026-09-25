import assert from 'node:assert/strict'
import test from 'node:test'
import { backtestReadiness, datasetIsReady, requiredHistoricalDatasets } from './backtestReadiness'
import type { HistoricalDataResponse } from './types'

const dataset = (symbol: string, complete: boolean, missingRanges: Array<{ start: string; end: string }> = [], cachedCandles = 100): HistoricalDataResponse => ({ symbol, interval: '5min', provider: 'Twelve Data', status: complete ? 'COMPLETE' : 'PARTIAL_DATA', candles: [], requestedStart: '2026-08-23T00:00:00.000Z', requestedEnd: '2026-09-23T23:55:00.000Z', actualStart: null, actualEnd: null, missingIntervals: missingRanges.length, missingRanges, cachedCandles, requiredCandles: 100, coveragePercent: complete ? 100 : 80, complete })

test('XAU/USD only requires XAU/USD and USD/DKK', () => {
  assert.deepEqual(requiredHistoricalDatasets(['XAU/USD']), ['XAU/USD', 'USD/DKK'])
  const result = backtestReadiness(['XAU/USD'], { 'XAU/USD': dataset('XAU/USD', true), 'USD/DKK': dataset('USD/DKK', true), 'USD/JPY': dataset('USD/JPY', false) })
  assert.equal(result.ready, true)
  assert.deepEqual(result.missing, [])
})

test('XAU/USD is blocked when its candles are partial', () => {
  const result = backtestReadiness(['XAU/USD'], { 'XAU/USD': dataset('XAU/USD', false), 'USD/DKK': dataset('USD/DKK', true) })
  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ['XAU/USD'])
})

test('XAU/USD is blocked when USD/DKK is partial', () => {
  const result = backtestReadiness(['XAU/USD'], { 'XAU/USD': dataset('XAU/USD', true), 'USD/DKK': dataset('USD/DKK', false) })
  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ['USD/DKK'])
})

test('USD/JPY requires USD/JPY candles and USD/DKK conversion', () => {
  assert.deepEqual(requiredHistoricalDatasets(['USD/JPY']), ['USD/JPY', 'USD/DKK'])
  const result = backtestReadiness(['USD/JPY'], { 'USD/JPY': dataset('USD/JPY', true), 'USD/DKK': dataset('USD/DKK', true) })
  assert.equal(result.ready, true)
})

test('both markets require the union of market candles and USD/DKK', () => {
  assert.deepEqual(requiredHistoricalDatasets(['XAU/USD', 'USD/JPY']), ['XAU/USD', 'USD/JPY', 'USD/DKK'])
  const result = backtestReadiness(['XAU/USD', 'USD/JPY'], { 'XAU/USD': dataset('XAU/USD', true), 'USD/JPY': dataset('USD/JPY', false), 'USD/DKK': dataset('USD/DKK', true) })
  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ['USD/JPY'])
})

test('excess candles do not hide an internal required gap', () => {
  const withGap = dataset('XAU/USD', true, [{ start: '2026-09-10T00:00:00.000Z', end: '2026-09-10T00:05:00.000Z' }], 1000)
  assert.equal(datasetIsReady(withGap), false)
  const result = backtestReadiness(['XAU/USD'], { 'XAU/USD': withGap, 'USD/DKK': dataset('USD/DKK', true) })
  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ['XAU/USD'])
})
