import type { IncomingMessage, ServerResponse } from 'node:http'

export type ProviderSymbol = 'XAU/USD' | 'USD/JPY'
export type Interval = '5min' | '15min'
export type NormalizedCandle = { symbol: ProviderSymbol; timestamp: string; open: number; high: number; low: number; close: number; interval: Interval; source: 'TWELVE_DATA'; closed: true }
type CacheEntry = { candles: NormalizedCandle[]; updatedAt: number }

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<CacheEntry>>()
const ttlMs: Record<Interval, number> = {
  '5min': 5 * 60_000,
  '15min': 15 * 60_000
}

export async function marketDataHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const symbol = url.searchParams.get('symbol')
  const interval = url.searchParams.get('interval')
  if (!isSymbol(symbol) || !isInterval(interval)) return writeJson(response, 400, { status: 'ERROR', error: 'Unsupported symbol or interval' })
  const key = `${symbol}:${interval}`
  const cached = cache.get(key)
  try {
    const entry = cached && Date.now() - cached.updatedAt < ttlMs[interval] ? cached : await getFresh(key, symbol, interval)
    const stale = Date.now() - entry.updatedAt >= ttlMs[interval]
    return writeJson(response, 200, { symbol, interval, provider: 'Twelve Data', status: stale ? 'STALE' : 'LIVE', candles: entry.candles, lastSuccessfulUpdate: new Date(entry.updatedAt).toISOString(), dataAgeSeconds: Math.floor((Date.now() - entry.updatedAt) / 1000), diagnostic: stale ? 'STALE_CACHE' : 'PROVIDER_CONNECTED' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider request failed'
    if (cached) return writeJson(response, 200, { symbol, interval, provider: 'Twelve Data', status: 'STALE', candles: cached.candles, lastSuccessfulUpdate: new Date(cached.updatedAt).toISOString(), dataAgeSeconds: Math.floor((Date.now() - cached.updatedAt) / 1000), diagnostic: 'STALE_CACHE', error: message })
    const diagnostic = message.includes('rate') ? 'RATE_LIMITED' : message.includes('malformed') ? 'INVALID_RESPONSE' : 'PROVIDER_ERROR'
    return writeJson(response, 502, { symbol, interval, provider: 'Twelve Data', status: 'ERROR', candles: [], lastSuccessfulUpdate: null, dataAgeSeconds: null, diagnostic, error: message })
  }
}

export async function getFresh(key: string, symbol: ProviderSymbol, interval: Interval): Promise<CacheEntry> {
  const cached = cache.get(key)

  // Genbrug frisk cache i stedet for at ramme Twelve Data igen.
  if (cached && Date.now() - cached.updatedAt < ttlMs[interval]) {
    return cached
  }

  const existing = inFlight.get(key)
  if (existing) return existing

  const request = fetchFromProvider(symbol, interval)
    .then(candles => {
      const entry = { candles, updatedAt: Date.now() }
      cache.set(key, entry)
      return entry
    })
    .catch(error => {
      // Ved midlertidig provider-fejl/rate limit må paperbotten bruge
      // eksisterende cache. paperEngine får derefter STALE-status og
      // kan selv blokere nye entries på stale data.
      if (cached) return cached
      throw error
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, request)
  return request
}

async function fetchFromProvider(symbol: ProviderSymbol, interval: Interval): Promise<NormalizedCandle[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY
  if (!apiKey) throw new Error('Twelve Data API key is not configured')
  const query = new URLSearchParams({ symbol, interval, outputsize: '500', timezone: 'UTC', apikey: apiKey })
  const providerResponse = await fetch(`https://api.twelvedata.com/time_series?${query}`)
  const body = await providerResponse.json() as { values?: Array<Record<string, string>>; status?: string; code?: number; message?: string }
  if (!providerResponse.ok || body.status === 'error' || body.code === 429) throw new Error(body.code === 429 ? 'rate limit response' : body.message ?? 'provider error')
  if (!Array.isArray(body.values)) throw new Error('malformed provider response')
  const candles = body.values.map(value => normalizeCandle(value, symbol, interval)).filter((candle): candle is NormalizedCandle => candle !== null).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  if (!candles.length) throw new Error('no usable candles')
  if (candles.some((candle, index) => index > 0 && candle.timestamp === candles[index - 1].timestamp)) throw new Error('malformed provider response: duplicate candle timestamp')
  return candles
}

function normalizeCandle(value: Record<string, string>, symbol: ProviderSymbol, interval: Interval): NormalizedCandle | null {
  const timestamp = value.datetime ? new Date(`${value.datetime.replace(' ', 'T')}Z`) : null
  const numbers = ['open', 'high', 'low', 'close'].map(field => Number(value[field]))
  if (!timestamp || Number.isNaN(timestamp.getTime()) || numbers.some(number => !Number.isFinite(number))) return null
  const [open, high, low, close] = numbers
  if (high < low || open < low || open > high || close < low || close > high) return null
  const intervalMs = interval === '5min' ? 5 * 60_000 : 15 * 60_000
  if (timestamp.getTime() + intervalMs > Date.now()) return null
  return { symbol, timestamp: timestamp.toISOString(), open, high, low, close, interval, source: 'TWELVE_DATA', closed: true }
}

function isSymbol(value: string | null): value is ProviderSymbol { return value === 'XAU/USD' || value === 'USD/JPY' }
function isInterval(value: string | null): value is Interval { return value === '5min' || value === '15min' }
function writeJson(response: ServerResponse, statusCode: number, payload: unknown) { response.statusCode = statusCode; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload)) }