import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historicalDataHandler, resetHistoricalRequestBudgetForTests } from './historicalData'
import { clearHistoricalCache, mergeHistoricalCandles, setHistoricalStoreDirectoryForTests, type StoredHistoricalCandle } from './historicalStore'

const candle = (timestamp: string, close: number): StoredHistoricalCandle => ({ symbol: 'XAU/USD', timestamp, open: close, high: close + 1, low: close - 1, close, interval: '5min', source: 'TWELVE_DATA', closed: true })

async function readResponse(): Promise<Record<string, unknown>> {
  let body = ''
  const response = { statusCode: 0, setHeader: () => undefined, end: (value: string) => { body = value } }
  await historicalDataHandler({ url: '/api/historical-data?symbol=XAU%2FUSD&interval=5min&start=2026-09-01T00%3A00%3A00.000Z&end=2026-09-23T00%3A00%3A00.000Z&collect=true' } as never, response as never)
  return JSON.parse(body) as Record<string, unknown>
}

test('duplicate-only response becomes NO_PROGRESS and is not requested again', async () => {
  setHistoricalStoreDirectoryForTests(await mkdtemp(join(tmpdir(), 'ai-forex-no-progress-test-')))
  await clearHistoricalCache()
  resetHistoricalRequestBudgetForTests()
  const cached = [candle('2026-09-20T00:00:00.000Z', 10), candle('2026-09-20T00:05:00.000Z', 11)]
  await mergeHistoricalCandles('XAU/USD', '5min', cached)
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ values: cached.map(value => ({ datetime: value.timestamp.replace('T', ' ').replace('.000Z', ''), open: String(value.open), high: String(value.high), low: String(value.low), close: String(value.close) })) }) } as Response }) as typeof fetch
  process.env.TWELVE_DATA_API_KEY = 'test-only'
  const first = await readResponse()
  assert.equal(first.status, 'NO_PROGRESS')
  assert.equal((first.lastCollection as { newUniqueCandles: number }).newUniqueCandles, 0)
  assert.equal((first.lastCollection as { duplicateCandles: number }).duplicateCandles, 2)
  const second = await readResponse()
  assert.equal(second.status, 'NO_PROGRESS')
  assert.equal(calls, 1)
  globalThis.fetch = originalFetch
  await clearHistoricalCache()
})
