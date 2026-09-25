import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearHistoricalCache, mergeHistoricalCandles, readHistoricalCandles, resetHistoricalStoreMemoryForTests, setHistoricalStoreDirectoryForTests, type StoredHistoricalCandle } from './historicalStore'

const candle = (timestamp: string, close: number): StoredHistoricalCandle => ({ symbol: 'XAU/USD', timestamp, open: close, high: close + 1, low: close - 1, close, interval: '5min', source: 'TWELVE_DATA', closed: true })

test('persistent store deduplicates, preserves valid data, and survives memory reset', async () => {
  setHistoricalStoreDirectoryForTests(await mkdtemp(join(tmpdir(), 'ai-forex-historical-test-')))
  await clearHistoricalCache()
  await mergeHistoricalCandles('XAU/USD', '5min', [candle('2026-09-22T00:00:00.000Z', 10), candle('2026-09-22T00:05:00.000Z', 11)])
  await mergeHistoricalCandles('XAU/USD', '5min', [candle('2026-09-22T00:00:00.000Z', 99), { ...candle('2026-09-22T00:10:00.000Z', 12), high: Number.NaN }])
  resetHistoricalStoreMemoryForTests()
  const restored = await readHistoricalCandles('XAU/USD', '5min')
  assert.deepEqual(restored.map(value => value.close), [10, 11])
  await clearHistoricalCache()
})
