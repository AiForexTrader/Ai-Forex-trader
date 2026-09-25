import type { IncomingMessage, ServerResponse } from 'node:http'
import { clearHistoricalCache, mergeHistoricalCandles, readHistoricalCandles, type StoredHistoricalCandle } from './historicalStore.ts'

type HistoricalSymbol = 'XAU/USD' | 'USD/JPY' | 'USD/DKK' | 'JPY/DKK'
type Interval = '5min' | '15min'
type CollectionStatus = 'READY' | 'CHECKING_CACHE' | 'DOWNLOADING' | 'PARTIAL_DATA' | 'RATE_LIMITED' | 'NO_PROGRESS' | 'MARKET_CLOSED_RANGE' | 'COMPLETE' | 'ERROR'
type BatchDiagnostics = { symbol: string; interval: Interval; requestedStart: string; requestedEnd: string; returnedOldestTimestamp: string | null; returnedNewestTimestamp: string | null; returnedCount: number; newUniqueCandles: number; duplicateCandles: number; cacheBefore: number; cacheAfter: number; outcome: 'NEW_DATA' | 'DUPLICATE_ONLY' | 'MARKET_CLOSED_RANGE' }
type HistoricalResponse = { symbol: string; interval: Interval; provider: 'Twelve Data'; status: CollectionStatus; candles: StoredHistoricalCandle[]; requestedStart: string; requestedEnd: string; actualStart: string | null; actualEnd: string | null; missingIntervals: number; missingRanges: Array<{ start: string; end: string }>; cachedCandles: number; requiredCandles: number; coveragePercent: number; complete: boolean; diagnostic?: string; nextAttemptAt?: string; lastSuccessfulRequest?: string | null; lastCollection?: BatchDiagnostics }
type RequestBudget = { attempted: number; successful: number; rateLimited: number; requestsWithNewData: number; requestsDuplicateOnly: number; newCandlesStored: number; lastRequestAt: string | null; lastRateLimitAt: string | null; retryAfter: string | null }

const maxBatchSize = 500
const budget: RequestBudget = { attempted: 0, successful: 0, rateLimited: 0, requestsWithNewData: 0, requestsDuplicateOnly: 0, newCandlesStored: 0, lastRequestAt: null, lastRateLimitAt: null, retryAfter: null }
let collectionLock: Promise<void> = Promise.resolve()
let lastSuccessfulRequest: string | null = null
let lastCollection: BatchDiagnostics | undefined
const noProgressCursors = new Set<string>()
const closedRanges = new Set<string>()

export function resetHistoricalRequestBudgetForTests(): void { budget.attempted = 0; budget.successful = 0; budget.rateLimited = 0; budget.requestsWithNewData = 0; budget.requestsDuplicateOnly = 0; budget.newCandlesStored = 0; budget.lastRequestAt = null; budget.lastRateLimitAt = null; budget.retryAfter = null; lastSuccessfulRequest = null; lastCollection = undefined; noProgressCursors.clear(); closedRanges.clear() }

export async function historicalDataHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.searchParams.get('action') === 'clear' && url.searchParams.get('confirm') === 'true') { await clearHistoricalCache(); return writeJson(response, 200, { status: 'READY', cleared: true }) }
  if (url.searchParams.get('action') === 'stats') return writeJson(response, 200, await cacheStats())
  const symbol = url.searchParams.get('symbol')
  const interval = url.searchParams.get('interval')
  const start = url.searchParams.get('start')
  const end = url.searchParams.get('end')
  if (!isSymbol(symbol) || !isInterval(interval) || !validDate(start) || !validDate(end) || Date.parse(start!) >= Date.parse(end!)) return writeJson(response, 400, { status: 'ERROR', error: 'Invalid historical-data parameters' })
  const result = await withCollectionLock(() => collect(symbol, interval, start!, end!, url.searchParams.get('collect') !== 'false'))
  return writeJson(response, 200, result)
}

async function collect(symbol: HistoricalSymbol, interval: Interval, requestedStart: string, requestedEnd: string, shouldCollect: boolean): Promise<HistoricalResponse> {
  const current = await readHistoricalCandles(symbol, interval)
  const before = summarize(symbol, interval, requestedStart, requestedEnd, current)
  if (!shouldCollect || before.complete) return { ...before, status: before.complete ? 'COMPLETE' : 'READY' }
  if (!process.env.TWELVE_DATA_API_KEY) return { ...before, status: 'ERROR', diagnostic: 'Twelve Data API key is not configured' }
  if (budget.retryAfter && Date.parse(budget.retryAfter) > Date.now()) return { ...before, status: 'RATE_LIMITED', diagnostic: 'Provider rate limit pause is active', nextAttemptAt: budget.retryAfter }
  const missing = findNextMissingRange(before, requestedStart, requestedEnd, interval)
  if (!missing) return { ...before, status: 'COMPLETE' }
  if (missing.marketClosed) {
    closedRanges.add(missing.key)
    return { ...before, status: 'MARKET_CLOSED_RANGE', diagnostic: 'The next missing interval contains no expected weekday trading slots; no provider request was made' }
  }
  const cursorKey = `${symbol}:${interval}:${missing.start}:${missing.end}`
  if (noProgressCursors.has(cursorKey)) return { ...before, status: 'NO_PROGRESS', diagnostic: 'Provider previously returned only cached candles for this range; collection paused for this cursor', lastCollection }
  try {
    const batch = await fetchBatch(symbol, interval, missing.start, missing.end)
    const cacheBefore = current.filter(candle => candle.timestamp >= requestedStart && candle.timestamp <= requestedEnd).length
    const merged = await mergeHistoricalCandles(symbol, interval, batch)
    const cacheAfter = merged.candles.filter(candle => candle.timestamp >= requestedStart && candle.timestamp <= requestedEnd).length
    const outcome = merged.newUniqueCandles > 0 ? 'NEW_DATA' : 'DUPLICATE_ONLY'
    lastCollection = { symbol, interval, requestedStart: missing.start, requestedEnd: missing.end, returnedOldestTimestamp: batch[0]?.timestamp ?? null, returnedNewestTimestamp: batch.at(-1)?.timestamp ?? null, returnedCount: batch.length, newUniqueCandles: merged.newUniqueCandles, duplicateCandles: merged.duplicateCandles, cacheBefore, cacheAfter, outcome }
    if (outcome === 'NEW_DATA') { budget.requestsWithNewData += 1; budget.newCandlesStored += merged.newUniqueCandles; noProgressCursors.delete(cursorKey) }
    else if (outcome === 'DUPLICATE_ONLY') { budget.requestsDuplicateOnly += 1; noProgressCursors.add(cursorKey) }
    lastSuccessfulRequest = new Date().toISOString()
    const after = summarize(symbol, interval, requestedStart, requestedEnd, merged.candles)
    if (outcome === 'DUPLICATE_ONLY') return { ...after, status: 'NO_PROGRESS', diagnostic: 'Provider returned already cached data; collection stopped for this cursor', lastCollection }
    if (outcome === 'MARKET_CLOSED_RANGE') return { ...after, status: after.complete ? 'COMPLETE' : 'MARKET_CLOSED_RANGE', lastCollection }
    return { ...after, status: after.complete ? 'COMPLETE' : 'PARTIAL_DATA', lastCollection }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Historical provider request failed'
    if (message.startsWith('RATE_LIMITED')) {
      budget.rateLimited += 1
      budget.lastRateLimitAt = new Date().toISOString()
      const retryAfter = parseRetryAfter(message)
      budget.retryAfter = retryAfter
      return { ...before, status: 'RATE_LIMITED', diagnostic: 'Provider rate limit received; cached candles were preserved', nextAttemptAt: retryAfter ?? undefined }
    }
    return { ...before, status: 'ERROR', diagnostic: message }
  }
}

async function fetchBatch(symbol: HistoricalSymbol, interval: Interval, start: string, end: string): Promise<StoredHistoricalCandle[]> {
  const query = new URLSearchParams({ symbol, interval, end_date: end, outputsize: String(maxBatchSize), timezone: 'UTC', apikey: process.env.TWELVE_DATA_API_KEY! })
  budget.attempted += 1
  budget.lastRequestAt = new Date().toISOString()
  const providerResponse = await fetchWithRetry(`https://api.twelvedata.com/time_series?${query}`)
  const retryAfter = providerResponse.headers.get('retry-after')
  if (providerResponse.status === 429) throw new Error(`RATE_LIMITED${retryAfter ? `:${retryAfter}` : ''}`)
  const body = await providerResponse.json() as { values?: Array<Record<string, string>>; status?: string; code?: number; message?: string }
  if (!providerResponse.ok || body.status === 'error' || body.code === 429) throw new Error(body.code === 429 ? 'RATE_LIMITED' : body.message ?? 'historical provider error')
  if (!Array.isArray(body.values)) throw new Error('malformed historical provider response')
  const candles = body.values.map(value => normalize(value, symbol, interval)).filter((value): value is StoredHistoricalCandle => value !== null).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  if (!candles.length) throw new Error('no usable historical candles')
  if (candles.some((candle, index) => index > 0 && candle.timestamp === candles[index - 1].timestamp)) throw new Error('duplicate historical candle timestamp')
  budget.successful += 1
  budget.retryAfter = null
  return candles
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastResponse: Response | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url)
    lastResponse = response
    if (response.status === 429 || response.status < 500) return response
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250))
  }
  return lastResponse!
}

function summarize(symbol: HistoricalSymbol, interval: Interval, requestedStart: string, requestedEnd: string, candles: StoredHistoricalCandle[]): HistoricalResponse {
  const normalizedStart = formatProviderDate(new Date(requestedStart), interval)
  const normalizedEnd = formatProviderDate(new Date(requestedEnd), interval)
  const inRange = candles.filter(candle => candle.timestamp >= normalizedStart && candle.timestamp <= normalizedEnd)
  const requiredCandles = expectedCandles(normalizedStart, normalizedEnd, interval)
  const missingRanges = findGaps(inRange, interval, normalizedStart, normalizedEnd)
  const coveragePercent = requiredCandles ? Math.min(100, inRange.length / requiredCandles * 100) : 0
  const complete = coveragePercent >= 99 && missingRanges.length === 0
  return { symbol, interval, provider: 'Twelve Data', status: complete ? 'COMPLETE' : 'READY', candles: inRange, requestedStart: normalizedStart, requestedEnd: normalizedEnd, actualStart: inRange[0]?.timestamp ?? null, actualEnd: inRange.at(-1)?.timestamp ?? null, missingIntervals: missingRanges.length, missingRanges, cachedCandles: inRange.length, requiredCandles, coveragePercent, complete, lastSuccessfulRequest }
}

export function findNextMissingRange(summary: Pick<HistoricalResponse, 'missingRanges'>, start: string, end: string, interval: Interval): { start: string; end: string; key: string; marketClosed: boolean } | null {
  const step = intervalMs(interval)
  const candidates = summary.missingRanges.map(gap => {
    const rangeStart = formatProviderDate(new Date(Date.parse(gap.start) + step), interval)
    const rangeEnd = formatProviderDate(new Date(Date.parse(gap.end) - step), interval)
    const closed = expectedCandles(rangeStart, rangeEnd, interval) === 0
    return { start: rangeStart, end: rangeEnd, key: `${rangeStart}:${rangeEnd}`, marketClosed: closed }
  }).filter(gap => Date.parse(gap.start) <= Date.parse(gap.end))
  const next = candidates.find(gap => !closedRanges.has(gap.key))
  if (!next) return null
  if (next.marketClosed) return next
  const cursorEnd = new Date(next.end)
  const cursorStart = new Date(Math.max(Date.parse(next.start), cursorEnd.getTime() - (maxBatchSize - 1) * step))
  return { ...next, start: formatProviderDate(cursorStart, interval), end: formatProviderDate(cursorEnd, interval), key: `${formatProviderDate(cursorStart, interval)}:${formatProviderDate(cursorEnd, interval)}` }
}

function findGaps(candles: StoredHistoricalCandle[], interval: Interval, start: string, end: string): Array<{ start: string; end: string }> {
  if (!candles.length) return [{ start, end }]
  const gaps: Array<{ start: string; end: string }> = []
  const step = intervalMs(interval)
  if (Date.parse(candles[0].timestamp) - Date.parse(start) >= step * 2) gaps.push({ start, end: candles[0].timestamp })
  for (let index = 1; index < candles.length; index += 1) if (Date.parse(candles[index].timestamp) - Date.parse(candles[index - 1].timestamp) >= step * 2) gaps.push({ start: candles[index - 1].timestamp, end: candles[index].timestamp })
  if (Date.parse(end) - Date.parse(candles.at(-1)!.timestamp) >= step * 2) gaps.push({ start: candles.at(-1)!.timestamp, end })
  return gaps
}

export function expectedCandles(start: string, end: string, interval: Interval): number { const step = intervalMs(interval); const first = Date.parse(formatProviderDate(new Date(start), interval)); const last = Date.parse(formatProviderDate(new Date(end), interval)); let count = 0; for (let time = first; time <= last; time += step) { const day = new Date(time).getUTCDay(); if (day !== 0 && day !== 6) count += 1 } return count }
function weekendOnly(start: string, end: string): boolean { const first = new Date(start).getUTCDay(); const last = new Date(end).getUTCDay(); return (first === 0 || first === 6) && (last === 0 || last === 6) }
function intervalMs(interval: Interval): number { return (interval === '5min' ? 5 : 15) * 60_000 }
function formatProviderDate(date: Date, interval: Interval): string { return new Date(Math.floor(date.getTime() / intervalMs(interval)) * intervalMs(interval)).toISOString() }
function parseRetryAfter(message: string): string | null { const seconds = Number(message.split(':')[1]); return Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000).toISOString() : null }
async function withCollectionLock<T>(work: () => Promise<T>): Promise<T> { const previous = collectionLock; let release!: () => void; collectionLock = new Promise(resolve => { release = resolve }); await previous; try { return await work() } finally { release() } }
async function cacheStats(): Promise<unknown> { const entries = await Promise.all((['XAU/USD', 'USD/JPY', 'USD/DKK', 'JPY/DKK'] as HistoricalSymbol[]).flatMap(symbol => (['5min', '15min'] as Interval[]).map(async interval => { const candles = await readHistoricalCandles(symbol, interval); return { symbol, interval, candles: candles.length, oldest: candles[0]?.timestamp ?? null, newest: candles.at(-1)?.timestamp ?? null } }))); return { entries, budget, lastSuccessfulRequest, lastCollection } }
function normalize(value: Record<string, string>, symbol: string, interval: Interval): StoredHistoricalCandle | null { if (!value.datetime) return null; const timestamp = new Date(`${value.datetime.replace(' ', 'T')}Z`); const numbers = ['open', 'high', 'low', 'close'].map(field => Number(value[field])); if (Number.isNaN(timestamp.getTime()) || numbers.some(number => !Number.isFinite(number))) return null; const [open, high, low, close] = numbers; const length = intervalMs(interval); if (high < low || open < low || open > high || close < low || close > high || timestamp.getTime() + length > Date.now()) return null; return { symbol, timestamp: timestamp.toISOString(), open, high, low, close, interval, source: 'TWELVE_DATA', closed: true } }
function isSymbol(value: string | null): value is HistoricalSymbol { return value === 'XAU/USD' || value === 'USD/JPY' || value === 'USD/DKK' || value === 'JPY/DKK' }
function isInterval(value: string | null): value is Interval { return value === '5min' || value === '15min' }
function validDate(value: string | null): value is string { return Boolean(value && !Number.isNaN(Date.parse(value))) }
function writeJson(response: ServerResponse, statusCode: number, payload: unknown) { response.statusCode = statusCode; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload)) }
