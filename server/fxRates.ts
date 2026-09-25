import type { IncomingMessage, ServerResponse } from 'node:http'

type Pair = 'USD/DKK' | 'JPY/DKK' | 'USD/JPY'
type PairRate = { pair: Pair; rate: number; timestamp: string; status: 'LIVE' | 'STALE'; ageSeconds: number; source: 'Twelve Data' }
type FxRateResponse = { baseCurrency: 'USD' | 'JPY'; quoteCurrency: 'DKK'; rate: number | null; timestamp: string | null; source: string; status: 'LIVE' | 'STALE' | 'ERROR' | 'NOT_CONNECTED'; ageSeconds: number | null; diagnostic?: 'DIRECT' | 'DERIVED' | 'PROVIDER_ERROR' | 'RATE_LIMITED' | 'STALE_CACHE' | 'NOT_CONNECTED'; error?: string }
type CacheEntry = { pair: Pair; rate: number; timestamp: string; updatedAt: number }

const cache = new Map<Pair, CacheEntry>()
const inFlight = new Map<Pair, Promise<PairRate>>()
const cacheTtlMs = 90_000
const maxCacheAgeSeconds = 300

export async function fxRatesHandler(
  _request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  return writeJson(response, 200, await loadFxRates())
}

export async function loadFxRates() {
  if (!process.env.TWELVE_DATA_API_KEY) {
    return {
      provider: 'Twelve Data' as const,
      fetchedAt: new Date().toISOString(),
      usdDkk: errorRate(
        'USD',
        'NOT_CONNECTED',
        'Twelve Data API key is not configured'
      ),
      jpyDkk: errorRate(
        'JPY',
        'NOT_CONNECTED',
        'Twelve Data API key is not configured'
      )
    }
  }

  const [usdDkk, jpyDkk] = await Promise.all([
    loadRate('USD/DKK').catch(error =>
      errorRate('USD', 'ERROR', errorMessage(error))
    ),
    loadJpyDkk().catch(error =>
      errorRate('JPY', 'ERROR', errorMessage(error))
    )
  ])

  return {
    provider: 'Twelve Data' as const,
    fetchedAt: new Date().toISOString(),
    usdDkk: isPairRate(usdDkk)
      ? toResponse(usdDkk, 'USD', 'DIRECT')
      : usdDkk,
    jpyDkk: isPairRate(jpyDkk)
      ? toResponse(
          jpyDkk,
          'JPY',
          jpyDkk.source === 'Twelve Data' ? 'DIRECT' : 'DERIVED'
        )
      : jpyDkk
  }
}

async function loadJpyDkk(): Promise<PairRate> {
  try {
    return await loadRate('JPY/DKK')
  } catch {
    const [usdDkk, usdJpy] = await Promise.all([loadRate('USD/DKK'), loadRate('USD/JPY')])
    const timestampDelta = Math.abs(Date.parse(usdDkk.timestamp) - Date.parse(usdJpy.timestamp))
    if (timestampDelta > 120_000) throw new Error('USD/DKK and USD/JPY timestamps are not compatible for a cross-rate')
    const rate = usdDkk.rate / usdJpy.rate
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('derived JPY/DKK rate is invalid')
    const timestamp = Date.parse(usdDkk.timestamp) >= Date.parse(usdJpy.timestamp) ? usdDkk.timestamp : usdJpy.timestamp
    return { pair: 'JPY/DKK', rate, timestamp, status: usdDkk.status === 'LIVE' && usdJpy.status === 'LIVE' ? 'LIVE' : 'STALE', ageSeconds: Math.max(usdDkk.ageSeconds, usdJpy.ageSeconds), source: 'Derived from Twelve Data' }
  }
}

async function loadRate(pair: Pair): Promise<PairRate> {
  const cached = cache.get(pair)
  if (cached && Date.now() - cached.updatedAt < cacheTtlMs) return fromCache(cached, 'LIVE')
  const existing = inFlight.get(pair)
  if (existing) return existing
  const request = fetchPair(pair).then(rate => { cache.set(pair, { ...rate, updatedAt: Date.now() }); return rate }).catch(error => {
    if (cached && Date.now() - cached.updatedAt <= maxCacheAgeSeconds * 1000) return fromCache(cached, 'STALE')
    throw error
  }).finally(() => inFlight.delete(pair))
  inFlight.set(pair, request)
  return request
}

async function fetchPair(pair: Pair): Promise<PairRate> {
  const query = new URLSearchParams({ symbol: pair, interval: '1min', outputsize: '2', timezone: 'UTC', apikey: process.env.TWELVE_DATA_API_KEY! })
  const providerResponse = await fetch(`https://api.twelvedata.com/time_series?${query}`)
  const body = await providerResponse.json() as { values?: Array<Record<string, string>>; status?: string; code?: number; message?: string }
  if (!providerResponse.ok || body.status === 'error' || body.code === 429) throw new Error(body.code === 429 ? 'rate limit response' : body.message ?? `provider error for ${pair}`)
  const latest = body.values?.[0]
  const rate = Number(latest?.close)
  const timestamp = latest?.datetime ? new Date(`${latest.datetime.replace(' ', 'T')}Z`) : null
  if (!timestamp || Number.isNaN(timestamp.getTime()) || !Number.isFinite(rate) || rate <= 0) throw new Error(`malformed provider response for ${pair}`)
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 1000))
  if (ageSeconds > maxCacheAgeSeconds) throw new Error(`${pair} rate is stale`)
  return { pair, rate, timestamp: timestamp.toISOString(), status: 'LIVE', ageSeconds, source: 'Twelve Data' }
}

function fromCache(entry: CacheEntry, status: 'LIVE' | 'STALE'): PairRate {
  return { pair: entry.pair, rate: entry.rate, timestamp: entry.timestamp, status, ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(entry.timestamp)) / 1000)), source: 'Twelve Data' }
}

function toResponse(value: PairRate, baseCurrency: 'USD' | 'JPY', diagnostic: 'DIRECT' | 'DERIVED'): FxRateResponse {
  return { baseCurrency, quoteCurrency: 'DKK', rate: value.rate, timestamp: value.timestamp, source: value.source, status: value.status, ageSeconds: value.ageSeconds, diagnostic }
}

function errorRate(baseCurrency: 'USD' | 'JPY', status: 'ERROR' | 'NOT_CONNECTED', error: string): FxRateResponse { return { baseCurrency, quoteCurrency: 'DKK', rate: null, timestamp: null, source: 'Twelve Data', status, ageSeconds: null, diagnostic: status === 'ERROR' ? 'PROVIDER_ERROR' : 'NOT_CONNECTED', error } }
function isPairRate(value: PairRate | FxRateResponse): value is PairRate { return 'pair' in value }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'FX provider request failed' }
function writeJson(response: ServerResponse, statusCode: number, payload: unknown) { response.statusCode = statusCode; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload)) }
