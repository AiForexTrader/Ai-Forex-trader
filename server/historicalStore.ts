import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

type HistoricalSymbol = 'XAU/USD' | 'USD/JPY' | 'USD/DKK' | 'JPY/DKK'
type Interval = '5min' | '15min'
export type StoredHistoricalCandle = { symbol: string; timestamp: string; open: number; high: number; low: number; close: number; interval: Interval; source: 'TWELVE_DATA'; closed: true }
export type HistoricalCacheKey = `${HistoricalSymbol}:${Interval}`
export type HistoricalMergeResult = { candles: StoredHistoricalCandle[]; newUniqueCandles: number; duplicateCandles: number }

let rootDirectory = path.join(process.cwd(), '.cache', 'ai-forex-trader', 'historical')
const memory = new Map<HistoricalCacheKey, StoredHistoricalCandle[]>()

export async function readHistoricalCandles(symbol: HistoricalSymbol, interval: Interval): Promise<StoredHistoricalCandle[]> {
  const key = `${symbol}:${interval}` as HistoricalCacheKey
  const existing = memory.get(key)
  if (existing) return existing
  try {
    const raw = JSON.parse(await readFile(filePath(symbol, interval), 'utf8')) as unknown
    const candles = Array.isArray(raw) ? raw.filter(isValid).sort(compareCandles) : []
    memory.set(key, candles)
    return candles
  } catch {
    memory.set(key, [])
    return []
  }
}

export async function mergeHistoricalCandles(symbol: HistoricalSymbol, interval: Interval, incoming: StoredHistoricalCandle[]): Promise<HistoricalMergeResult> {
  const current = await readHistoricalCandles(symbol, interval)
  const byTimestamp = new Map(current.map(candle => [candle.timestamp, candle]))
  let newUniqueCandles = 0
  let duplicateCandles = 0
  for (const candle of incoming) {
    if (!isValid(candle)) continue
    if (byTimestamp.has(candle.timestamp)) duplicateCandles += 1
    else { byTimestamp.set(candle.timestamp, candle); newUniqueCandles += 1 }
  }
  const merged = [...byTimestamp.values()].sort(compareCandles)
  memory.set(`${symbol}:${interval}` as HistoricalCacheKey, merged)
  await persist(symbol, interval, merged)
  return { candles: merged, newUniqueCandles, duplicateCandles }
}

export async function clearHistoricalCache(): Promise<void> {
  memory.clear()
  const { readdir, unlink } = await import('node:fs/promises')
  try {
    for (const file of await readdir(rootDirectory)) if (file.endsWith('.json')) await unlink(path.join(rootDirectory, file))
  } catch { /* Cache directory may not exist yet. */ }
}

export function cacheFilePath(symbol: HistoricalSymbol, interval: Interval): string { return filePath(symbol, interval) }

export function resetHistoricalStoreMemoryForTests(): void { memory.clear() }
export function setHistoricalStoreDirectoryForTests(directory: string): void { memory.clear(); rootDirectory = directory }

async function persist(symbol: HistoricalSymbol, interval: Interval, candles: StoredHistoricalCandle[]): Promise<void> {
  await mkdir(rootDirectory, { recursive: true })
  const target = filePath(symbol, interval)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(candles), 'utf8')
  await rename(temporary, target)
}

function filePath(symbol: HistoricalSymbol, interval: Interval): string { return path.join(rootDirectory, `${encodeURIComponent(symbol)}-${interval}.json`) }
function compareCandles(left: StoredHistoricalCandle, right: StoredHistoricalCandle): number { return left.timestamp.localeCompare(right.timestamp) }
function isValid(value: unknown): value is StoredHistoricalCandle {
  if (!value || typeof value !== 'object') return false
  const candle = value as Partial<StoredHistoricalCandle>
  return typeof candle.symbol === 'string' && typeof candle.timestamp === 'string' && !Number.isNaN(Date.parse(candle.timestamp)) && [candle.open, candle.high, candle.low, candle.close].every(number => typeof number === 'number' && Number.isFinite(number)) && candle.high! >= candle.low! && candle.open! >= candle.low! && candle.open! <= candle.high! && candle.close! >= candle.low! && candle.close! <= candle.high! && candle.closed === true && candle.source === 'TWELVE_DATA'
}
