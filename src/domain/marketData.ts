import type { Candle, MarketDataResponse, Symbol } from './types'
import { SESSION_CONFIG } from './session'

export const intervals = ['5min', '15min'] as const
export type MarketInterval = (typeof intervals)[number]

export async function fetchMarketData(symbol: Symbol, interval: MarketInterval, signal?: AbortSignal): Promise<MarketDataResponse> {
  const query = new URLSearchParams({ symbol, interval })
  const response = await fetch(`/api/market-data?${query}`, { signal })
  const payload = await response.json() as MarketDataResponse
  if (!response.ok && payload.status !== 'STALE') throw new Error(payload.error ?? 'Market data request failed')
  return payload
}

export function getAsianRange(candles: Candle[]): { high: number | null; low: number | null } {
  const range = getAsianSessionRange(candles)
  return range ? { high: range.high, low: range.low } : { high: null, low: null }
}

export function getAsianSessionRange(candles: Candle[]): { sessionDate: string; high: number; low: number; establishedAt: string } | null {
  const asianCandles = candles.filter(candle => isAsianSession(candle.timestamp))
  const latestSession = asianCandles.map(candle => sessionDate(candle.timestamp)).sort().at(-1)
  const sessionCandles = asianCandles.filter(candle => candle.closed && sessionDate(candle.timestamp) === latestSession)
  if (!sessionCandles.length || !latestSession) return null
  return { sessionDate: latestSession, high: Math.max(...sessionCandles.map(candle => candle.high)), low: Math.min(...sessionCandles.map(candle => candle.low)), establishedAt: sessionCandles.at(-1)!.timestamp }
}

function isAsianSession(timestamp: string): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp)).find(part => part.type === 'hour')?.value)
  return hour >= SESSION_CONFIG.asian.startHour && hour < SESSION_CONFIG.asian.endHour
}

function sessionDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SESSION_CONFIG.asian.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
}