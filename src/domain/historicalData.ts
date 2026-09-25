import type { HistoricalBatchDiagnostics, HistoricalDataResponse } from './types'

export interface HistoricalCacheStats { entries: Array<{ symbol: string; interval: string; candles: number; oldest: string | null; newest: string | null }>; budget: { attempted: number; successful: number; rateLimited: number; requestsWithNewData: number; requestsDuplicateOnly: number; newCandlesStored: number; lastRequestAt: string | null; lastRateLimitAt: string | null; retryAfter: string | null }; lastSuccessfulRequest: string | null; lastCollection?: HistoricalBatchDiagnostics }

export async function fetchHistoricalData(symbol: string, interval: '5min' | '15min', start: string, end: string, signal?: AbortSignal, collect = true): Promise<HistoricalDataResponse> {
  const query = new URLSearchParams({ symbol, interval, start, end, collect: String(collect) })
  const response = await fetch(`/api/historical-data?${query}`, { signal })
  const payload = await response.json() as HistoricalDataResponse
  return payload
}

export async function fetchHistoricalCacheStats(): Promise<HistoricalCacheStats> {
  const response = await fetch('/api/historical-data?action=stats')
  return await response.json() as HistoricalCacheStats
}

export async function clearHistoricalCache(): Promise<void> {
  await fetch('/api/historical-data?action=clear&confirm=true')
}
