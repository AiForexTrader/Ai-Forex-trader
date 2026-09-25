import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defaultState } from '../src/storage/persistence'
import { processMarketCycle } from '../src/domain/paperEngine'
import { getAsianSessionRange } from '../src/domain/marketData'
import { getActiveSession } from '../src/domain/session'
import type {
  FxRatesResponse,
  MarketDataResponse,
  PersistedState,
  Symbol
} from '../src/domain/types'
import { getFresh } from './marketData'
import { loadFxRates } from './fxRates'

const symbols: Symbol[] = ['XAU/USD', 'USD/JPY']

const stateFile = resolve('.paper-data/state.json')

let paperState: PersistedState = defaultState()
let stateLoaded = false
let running: Promise<void> | null = null
let lastCycleAt: string | null = null
let lastError: string | null = null

const AUTO_CYCLE_MS = 60_000
let autoLoopStarted = false
let autoTimer: ReturnType<typeof setInterval> | null = null


async function ensureStateLoaded(): Promise<void> {
  if (stateLoaded) return

  try {
    const raw = await readFile(stateFile, 'utf8')
    paperState = JSON.parse(raw) as PersistedState
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error
        ? String(error.code)
        : ''

    if (code !== 'ENOENT') throw error

    paperState = defaultState()
    await persistState()
  }

  stateLoaded = true
}

async function persistState(): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true })

  const temporary = `${stateFile}.tmp`
  await writeFile(temporary, JSON.stringify(paperState, null, 2), 'utf8')

  const { rename } = await import('node:fs/promises')
  await rename(temporary, stateFile)
}

async function marketDataFor(symbol: Symbol): Promise<MarketDataResponse> {
  const entry = await getFresh(`${symbol}:5min`, symbol, '5min')
  const ageMs = Date.now() - entry.updatedAt
  const stale = ageMs >= 5 * 60_000

  return {
    symbol,
    interval: '5min',
    provider: 'Twelve Data',
    status: stale ? 'STALE' : 'LIVE',
    candles: entry.candles,
    lastSuccessfulUpdate: new Date(entry.updatedAt).toISOString(),
    dataAgeSeconds: Math.floor(ageMs / 1000),
    diagnostic: stale ? 'STALE_CACHE' : 'PROVIDER_CONNECTED'
  }
}

async function runPaperCycle(): Promise<void> {
  if (running) return running

  running = (async () => {
    try {
      await ensureStateLoaded()

      for (const symbol of symbols) {
        const marketData = await marketDataFor(symbol)
        const latest = marketData.candles.at(-1)

        // Ingen ny lukket 5-minutters candle = ingen ny strategibehandling
        // og derfor heller intet unødvendigt FX-kald.
        if (
          !latest ||
          !latest.closed ||
          paperState.strategyStates[symbol].lastProcessedCandle === latest.timestamp
        ) {
          continue
        }

        // Hent først FX når der faktisk er en ny candle at behandle.
        // Den eksisterende maxFxAgeSeconds-regel gælder stadig.
        const fxRates = await loadFxRates() as FxRatesResponse
        const asian = getAsianSessionRange(marketData.candles)

        const cycle = processMarketCycle({
          state: paperState,
          symbol,
          candles: marketData.candles,
          marketStatus: marketData.status,
          session: getActiveSession(new Date()),
          asianRange: asian
            ? {
                ...asian,
                timeZone: 'Asia/Tokyo'
              }
            : null,
          fxRates,
          now: new Date().toISOString()
        })

        paperState = cycle.state
      }

      await persistState()
      lastCycleAt = new Date().toISOString()
      lastError = null
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : 'Unknown paper trading error'
      throw error
    }
  })().finally(() => {
    running = null
  })

  return running
}

export function startPaperTradingLoop(): void {
  if (autoLoopStarted) return

  autoLoopStarted = true

  // Kør én cycle med det samme.
  void runPaperCycle().catch(error => {
    console.error('Paper trading cycle failed:', error)
  })

  autoTimer = setInterval(() => {
    void runPaperCycle().catch(error => {
      console.error('Paper trading cycle failed:', error)
    })
  }, AUTO_CYCLE_MS)

  console.log('Paper trading server loop started (PAPER ONLY)')
}

export async function paperTradingHandler(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    await ensureStateLoaded()
    const url = new URL(request.url ?? '/', 'http://localhost')
    const action = url.searchParams.get('action')

    if (action === 'run') {
      await runPaperCycle()
    }

    return writeJson(response, 200, {
      mode: 'PAPER_ONLY',
      running: running !== null,
      autoTrading: autoLoopStarted,
      intervalMs: AUTO_CYCLE_MS,
      lastCycleAt,
      lastError,
      state: paperState
    })
  } catch (error) {
    return writeJson(response, 500, {
      mode: 'PAPER_ONLY',
      running: false,
      lastCycleAt,
      lastError:
        error instanceof Error ? error.message : 'Unknown paper trading error',
      state: paperState
    })
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}
