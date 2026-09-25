import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historicalDataHandler, resetHistoricalRequestBudgetForTests } from './historicalData'
import { clearHistoricalCache, setHistoricalStoreDirectoryForTests } from './historicalStore'

const start = '2026-09-22T00:00:00.000Z'
const end = '2026-09-22T00:15:00.000Z'
const candleValues = (timestamps: string[]) => timestamps.map((datetime, index) => ({ datetime: datetime.replace('T', ' ').replace('.000Z', ''), open: String(100 + index), high: String(101 + index), low: String(99 + index), close: String(100.5 + index) }))

async function request(collect = true): Promise<Record<string, unknown>> {
  let body = ''
  const response = { statusCode: 0, setHeader: () => undefined, end: (value: string) => { body = value } }
  await historicalDataHandler({ url: `/api/historical-data?symbol=USD%2FDKK&interval=5min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&collect=${collect}` } as never, response as never)
  return JSON.parse(body) as Record<string, unknown>
}

test('rate limit preserves persisted batch and continuation requests only missing data', async () => {
  setHistoricalStoreDirectoryForTests(await mkdtemp(join(tmpdir(), 'ai-forex-historical-handler-test-')))
  await clearHistoricalCache()
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  process.env.TWELVE_DATA_API_KEY = 'test-only'
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ values: candleValues(['2026-09-22T00:00:00.000Z', '2026-09-22T00:05:00.000Z']) }) } as Response
  }) as typeof fetch
  const first = await request()
  assert.equal(first.cachedCandles, 2)
  const callsAfterFirst = calls.length
  globalThis.fetch = (async (input: string | URL | Request) => { calls.push(String(input)); return { status: 429, ok: false, headers: { get: (name: string) => name === 'retry-after' ? '60' : null }, json: async () => ({ code: 429, message: 'rate limited' }) } }) as typeof fetch
  const limited = await request()
  assert.equal(limited.status, 'RATE_LIMITED')
  assert.equal(limited.cachedCandles, 2)
  const callsAfterLimit = calls.length
  const paused = await request()
  assert.equal(paused.status, 'RATE_LIMITED')
  assert.equal(calls.length, callsAfterLimit)
  resetHistoricalRequestBudgetForTests()
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ values: candleValues(['2026-09-22T00:10:00.000Z', '2026-09-22T00:15:00.000Z']) }) } as Response
  }) as typeof fetch
  const continued = await request()
  assert.equal(continued.status, 'COMPLETE')
  assert.equal(continued.cachedCandles, 4)
  assert.equal(calls.length, callsAfterFirst + 2)
  assert.ok(calls.at(-1)!.includes('end_date=2026-09-22'))
  assert.equal((continued.lastCollection as { newUniqueCandles: number }).newUniqueCandles, 2)
  await clearHistoricalCache()
  globalThis.fetch = originalFetch
})
