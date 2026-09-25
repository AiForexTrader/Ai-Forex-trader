
import { conversionForSymbol } from './fxRates'
import { processMarketCycle } from './paperEngine'
import { defaultState } from '../storage/persistence'
import { getActiveSession, SESSION_CONFIG } from './session'
import type { BacktestMetrics, BacktestRejections, BacktestRun, BacktestSplit, Candle, DatasetSegment, FxRateSnapshot, FxRatesResponse, HistoricalCandle, HistoricalDataResponse, PersistedState, ResearchValidationStatus, StrategySettings, Symbol, Trade } from './types'

export interface BacktestInput {
  symbols: Symbol[]
  timeframe: '5min' | '15min'
  marketData: Partial<Record<Symbol, HistoricalDataResponse>>
  usdDkk: HistoricalCandle[]
  jpyDkk: HistoricalCandle[]
  usdJpy: HistoricalCandle[]
  requestedStart: string
  requestedEnd: string
  settings: StrategySettings
}

export function runBacktest(input: BacktestInput): BacktestRun {
  const allTrades: Trade[] = []
  const allCandles: HistoricalCandle[] = []
  const segmentTrades: Record<DatasetSegment, Trade[]> = { TRAINING: [], VALIDATION: [], OUT_OF_SAMPLE: [] }
  const rejectionCounts = emptyRejections()
  let runStatus: BacktestRun['status'] = 'COMPLETE'
  let actualStart: string | null = null
  let actualEnd: string | null = null

  const state = defaultState()
  state.settings = structuredClone(input.settings)
  const events: Array<{ symbol: Symbol; data: HistoricalCandle[]; index: number }> = []
  const segmentMaps = new Map<Symbol, Map<string, DatasetSegment>>()
  for (const symbol of input.symbols) {
    const data = input.marketData[symbol]
    if (!data) continue
    if (data.status === 'RATE_LIMITED') runStatus = 'RATE_LIMITED'
    else if (data.status === 'PARTIAL_DATA' && runStatus === 'COMPLETE') runStatus = 'PARTIAL_DATA'
    if (!data.candles.length) continue
    allCandles.push(...data.candles)
    if (actualStart === null || data.candles[0].timestamp < actualStart) actualStart = data.candles[0].timestamp
    if (actualEnd === null || data.candles.at(-1)!.timestamp > actualEnd) actualEnd = data.candles.at(-1)!.timestamp
    const splits = splitChronological(data.candles)
    segmentMaps.set(symbol, new Map(splits.flatMap(split => split.candles.map(candle => [candle.timestamp, split.segment] as const))))
    for (let index = 0; index < data.candles.length; index += 1) events.push({ symbol, data: data.candles, index })
  }
  events.sort((left, right) => left.data[left.index].timestamp.localeCompare(right.data[right.index].timestamp) || left.symbol.localeCompare(right.symbol))

  // Build candle history and Asian range incrementally.
  const replayCandles = new Map<Symbol, Candle[]>()
  const asianRanges = new Map<Symbol, {
    sessionDate: string
    high: number
    low: number
    establishedAt: string
  }>()

  for (const symbol of input.symbols) {
    replayCandles.set(symbol, [])
  }

  const tokyoHourFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: SESSION_CONFIG.asian.timeZone,
    hour: '2-digit',
    hourCycle: 'h23'
  })

  const tokyoDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SESSION_CONFIG.asian.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })

  const historicalFxCursor = createHistoricalFxCursor(
    input.usdDkk,
    input.jpyDkk,
    input.usdJpy
  )

  for (const event of events) {
    const historical = event.data[event.index]
    const candles = replayCandles.get(event.symbol) ?? []
    const candle = toStrategyCandle(historical, event.symbol)
    candles.push(candle)

    const tokyoHour = Number(
      tokyoHourFormatter.format(new Date(candle.timestamp))
    )

    if (
      candle.closed &&
      tokyoHour >= SESSION_CONFIG.asian.startHour &&
      tokyoHour < SESSION_CONFIG.asian.endHour
    ) {
      const date = tokyoDateFormatter.format(new Date(candle.timestamp))
      const current = asianRanges.get(event.symbol)

      if (!current || current.sessionDate !== date) {
        asianRanges.set(event.symbol, {
          sessionDate: date,
          high: candle.high,
          low: candle.low,
          establishedAt: candle.timestamp
        })
      } else {
        current.high = Math.max(current.high, candle.high)
        current.low = Math.min(current.low, candle.low)
        current.establishedAt = candle.timestamp
      }
    }

    const fxRates = historicalFxAt(
      historical.timestamp,
      input.usdDkk,
      input.jpyDkk,
      input.usdJpy
    )

    const range = asianRanges.get(event.symbol) ?? null

    const cycle = processMarketCycle({
      state,
      symbol: event.symbol,
      candles,
      marketStatus: 'LIVE',
      session: getActiveSession(new Date(historical.timestamp)),
      asianRange: range ? { ...range, timeZone: 'Asia/Tokyo' } : null,
      fxRates,
      now: historical.timestamp,
      historicalReplay: true
    })
    Object.assign(state, cycle.state)

    if (cycle.journalEntry) {
      countRejection(cycle.journalEntry, rejectionCounts)
    }
    for (const trade of cycle.opened ? [cycle.opened] : []) annotateTrade(trade, input.timeframe, segmentMaps.get(event.symbol)?.get(trade.entryCandleTimestamp) ?? 'TRAINING')
    for (const trade of cycle.closed) annotateTrade(trade, input.timeframe, segmentMaps.get(event.symbol)?.get(trade.entryCandleTimestamp) ?? 'TRAINING')
  }
  allTrades.push(...state.account.completedTrades)

  for (const trade of allTrades) segmentTrades[trade.datasetSegment ?? 'TRAINING'].push(trade)
  const splitRanges = splitChronological(allCandles.sort((a, b) => a.timestamp.localeCompare(b.timestamp))).map(split => ({ segment: split.segment, start: split.candles[0]?.timestamp ?? '', end: split.candles.at(-1)?.timestamp ?? '', metrics: calculateBacktestMetrics(splitTrades(segmentTrades, split.segment)) }))
  const metrics = calculateBacktestMetrics(allTrades)
  const breakdowns: Record<string, BacktestMetrics> = {}
  for (const symbol of input.symbols) breakdowns[`SYMBOL:${symbol}`] = calculateBacktestMetrics(allTrades.filter(trade => trade.symbol === symbol))
  breakdowns[`TIMEFRAME:${input.timeframe}`] = metrics
  breakdowns.BUY = calculateBacktestMetrics(allTrades.filter(trade => trade.side === 'BUY'))
  breakdowns.SELL = calculateBacktestMetrics(allTrades.filter(trade => trade.side === 'SELL'))
  for (const session of ['LONDON', 'LONDON / NY OVERLAP'] as const) breakdowns[`SESSION:${session}`] = calculateBacktestMetrics(allTrades.filter(trade => trade.session === session))
  for (const segment of ['TRAINING', 'VALIDATION', 'OUT_OF_SAMPLE'] as DatasetSegment[]) breakdowns[segment] = calculateBacktestMetrics(segmentTrades[segment])
  return { runId: `backtest-${Date.now()}`, strategyVersion: input.settings.strategyVersion, symbols: input.symbols, timeframe: input.timeframe, requestedStart: input.requestedStart, requestedEnd: input.requestedEnd, actualStart, actualEnd, candlesProcessed: allCandles.length, status: runStatus, provider: 'Twelve Data', conversionMethod: 'HISTORICAL_FX', costAssumption: Object.values(input.settings.spread).some(value => value > 0) || Object.values(input.settings.slippage).some(value => value > 0) ? 'CONFIGURED_COST' : 'ZERO_COST_BASELINE', settingsSnapshot: structuredClone(input.settings), metrics, splits: splitRanges, breakdowns, validationStatus: validationStatus(splitRanges), rejections: rejectionCounts, trades: allTrades, createdAt: new Date().toISOString(), diagnostic: runStatus === 'PARTIAL_DATA' ? 'Provider returned a bounded or incomplete historical dataset.' : undefined }
}

function validationStatus(splits: BacktestSplit[]): ResearchValidationStatus {
  const training = splits.find(split => split.segment === 'TRAINING')?.metrics
  const validation = splits.find(split => split.segment === 'VALIDATION')?.metrics
  const outOfSample = splits.find(split => split.segment === 'OUT_OF_SAMPLE')?.metrics
  if (!training || !validation || !outOfSample || training.completedTrades < 30 || validation.completedTrades < 30 || outOfSample.completedTrades < 30) return 'INSUFFICIENT_DATA'
  if (outOfSample.netPnl <= 0 || (outOfSample.profitFactor ?? 0) < 1) return 'REJECTED'
  if ((outOfSample.winRate ?? 0) >= 65 && (validation.profitFactor ?? 0) >= 1 && (training.profitFactor ?? 0) >= 1) return 'VALIDATED'
  if (outOfSample.netPnl > 0) return 'PROMISING'
  return 'RESEARCHING'
}

export function splitChronological(candles: HistoricalCandle[]): Array<{ segment: DatasetSegment; candles: HistoricalCandle[] }> {
  if (!candles.length) return [{ segment: 'TRAINING', candles: [] }]
  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const firstBoundary = alignToDay(sorted, Math.floor(sorted.length * 0.6))
  const secondBoundary = alignToDay(sorted, Math.floor(sorted.length * 0.8), firstBoundary)
  const splits: Array<{ segment: DatasetSegment; candles: HistoricalCandle[] }> = [{ segment: 'TRAINING', candles: sorted.slice(0, firstBoundary) }, { segment: 'VALIDATION', candles: sorted.slice(firstBoundary, secondBoundary) }, { segment: 'OUT_OF_SAMPLE', candles: sorted.slice(secondBoundary) }]
  return splits.filter(split => split.candles.length)
}

export function calculateBacktestMetrics(trades: Trade[], startingEquity = 10000): BacktestMetrics {
  const closed = trades.filter(trade => trade.exitTimestamp && (trade.netPnlDkk ?? trade.pnlDkk) !== null)
  const wins = closed.filter(trade => trade.winning)
  const losses = closed.filter(trade => trade.winning === false)
  const grossPnl = closed.reduce((sum, trade) => sum + (trade.grossPnlDkk ?? trade.pnlDkk ?? 0), 0)
  const netPnl = closed.reduce((sum, trade) => sum + (trade.netPnlDkk ?? trade.pnlDkk ?? 0), 0)
  const grossWins = wins.reduce((sum, trade) => sum + Math.max(0, trade.grossPnlDkk ?? trade.pnlDkk ?? 0), 0)
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + Math.min(0, trade.grossPnlDkk ?? trade.pnlDkk ?? 0), 0))
  const rs = closed.map(trade => trade.pnlR ?? 0).sort((a, b) => a - b)
  let equity = startingEquity
  let peak = startingEquity
  let maxDrawdown = 0
  let currentLosingStreak = 0
  let largestLosingStreak = 0
  let largestWinningStreak = 0
  let winningStreak = 0
  for (const trade of closed) {
    const pnl = trade.netPnlDkk ?? trade.pnlDkk ?? 0
    equity += pnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    if (trade.winning) { currentLosingStreak = 0; winningStreak += 1; largestWinningStreak = Math.max(largestWinningStreak, winningStreak) } else { currentLosingStreak += 1; winningStreak = 0; largestLosingStreak = Math.max(largestLosingStreak, currentLosingStreak) }
  }
  const holdingMinutes = closed.map(trade => trade.exitTimestamp && trade.entryTimestamp ? (Date.parse(trade.exitTimestamp) - Date.parse(trade.entryTimestamp)) / 60_000 : 0)
  return { completedTrades: closed.length, wins: wins.length, losses: losses.length, winRate: closed.length ? wins.length / closed.length * 100 : null, grossPnl, netPnl, returnPercent: startingEquity ? netPnl / startingEquity * 100 : 0, averageWin: wins.length ? wins.reduce((sum, trade) => sum + (trade.netPnlDkk ?? trade.pnlDkk ?? 0), 0) / wins.length : null, averageLoss: losses.length ? losses.reduce((sum, trade) => sum + (trade.netPnlDkk ?? trade.pnlDkk ?? 0), 0) / losses.length : null, averageR: closed.length ? rs.reduce((sum, value) => sum + value, 0) / closed.length : null, medianR: rs.length ? rs[Math.floor(rs.length / 2)] : null, profitFactor: grossLosses ? grossWins / grossLosses : null, expectancyPerTrade: closed.length ? netPnl / closed.length : null, maxDrawdown, maxDrawdownPercent: startingEquity ? maxDrawdown / startingEquity * 100 : 0, currentLosingStreak, largestLosingStreak, largestWinningStreak, averageHoldingMinutes: holdingMinutes.length ? holdingMinutes.reduce((sum, value) => sum + value, 0) / holdingMinutes.length : null, ambiguousIntrabarCount: closed.filter(trade => trade.exitReason === 'AMBIGUOUS_INTRABAR').length }
}

function createHistoricalFxCursor(
  usdDkk: HistoricalCandle[],
  jpyDkk: HistoricalCandle[],
  usdJpy: HistoricalCandle[]
) {
  let usdIndex = -1
  let jpyIndex = -1
  let usdJpyIndex = -1

  const advance = (
    candles: HistoricalCandle[],
    currentIndex: number,
    timestamp: string
  ): number => {
    while (
      currentIndex + 1 < candles.length &&
      candles[currentIndex + 1].timestamp <= timestamp
    ) {
      currentIndex += 1
    }
    return currentIndex
  }

  return {
    at(timestamp: string): FxRatesResponse | null {
      usdIndex = advance(usdDkk, usdIndex, timestamp)
      jpyIndex = advance(jpyDkk, jpyIndex, timestamp)
      usdJpyIndex = advance(usdJpy, usdJpyIndex, timestamp)

      const usd = usdIndex >= 0 ? usdDkk[usdIndex] : null
      const directJpy = jpyIndex >= 0 ? jpyDkk[jpyIndex] : null
      const crossUsdJpy = usdJpyIndex >= 0 ? usdJpy[usdJpyIndex] : null

      if (!usd) return null

      const usdSnapshot = toFxSnapshot(
        'USD',
        usd,
        timestamp,
        'HISTORICAL_FX'
      )

      let jpySnapshot: FxRateSnapshot | null = directJpy
        ? toFxSnapshot('JPY', directJpy, timestamp, 'HISTORICAL_FX')
        : null

      if (
        !jpySnapshot &&
        crossUsdJpy &&
        Math.abs(
          Date.parse(usd.timestamp) -
          Date.parse(crossUsdJpy.timestamp)
        ) <= 120_000
      ) {
        const rate = usd.close / crossUsdJpy.close

        if (Number.isFinite(rate) && rate > 0) {
          const sourceTimestamp = Math.max(
            Date.parse(usd.timestamp),
            Date.parse(crossUsdJpy.timestamp)
          )

          jpySnapshot = {
            baseCurrency: 'JPY',
            quoteCurrency: 'DKK',
            rate,
            timestamp: new Date(sourceTimestamp).toISOString(),
            source: 'Derived historical Twelve Data',
            status: 'LIVE',
            ageSeconds: Math.floor(
              (Date.parse(timestamp) - sourceTimestamp) / 1000
            ),
            diagnostic: 'DERIVED'
          }
        }
      }

      if (!jpySnapshot) return null

      return {
        provider: 'Twelve Data',
        usdDkk: usdSnapshot,
        jpyDkk: jpySnapshot,
        fetchedAt: timestamp
      }
    }
  }
}

export function historicalFxAt(timestamp: string, usdDkk: HistoricalCandle[], jpyDkk: HistoricalCandle[], usdJpy: HistoricalCandle[]): FxRatesResponse | null {
  const usd = latestAtOrBefore(usdDkk, timestamp)
  const directJpy = latestAtOrBefore(jpyDkk, timestamp)
  const crossUsdJpy = latestAtOrBefore(usdJpy, timestamp)
  if (!usd) return null
  const usdSnapshot = toFxSnapshot('USD', usd, timestamp, 'HISTORICAL_FX')
  let jpySnapshot: FxRateSnapshot | null = directJpy ? toFxSnapshot('JPY', directJpy, timestamp, 'HISTORICAL_FX') : null
  if (!jpySnapshot && crossUsdJpy && Math.abs(Date.parse(usd.timestamp) - Date.parse(crossUsdJpy.timestamp)) <= 120_000) {
    const rate = usd.close / crossUsdJpy.close
    if (Number.isFinite(rate) && rate > 0) jpySnapshot = { baseCurrency: 'JPY', quoteCurrency: 'DKK', rate, timestamp: new Date(Math.max(Date.parse(usd.timestamp), Date.parse(crossUsdJpy.timestamp))).toISOString(), source: 'Derived historical Twelve Data', status: 'LIVE', ageSeconds: Math.floor((Date.parse(timestamp) - Math.max(Date.parse(usd.timestamp), Date.parse(crossUsdJpy.timestamp))) / 1000), diagnostic: 'DERIVED' }
  }
  const unavailableJpySnapshot: FxRateSnapshot = {
    baseCurrency: 'JPY',
    quoteCurrency: 'DKK',
    rate: null,
    timestamp: null,
    source: 'Historical FX unavailable',
    status: 'NOT_CONNECTED',
    ageSeconds: null,
    diagnostic: 'NOT_CONNECTED'
  }

  return {
    provider: 'Twelve Data',
    usdDkk: usdSnapshot,
    jpyDkk: jpySnapshot ?? unavailableJpySnapshot,
    fetchedAt: timestamp
  }
}

function latestAtOrBefore(candles: HistoricalCandle[], timestamp: string): HistoricalCandle | null { let latest: HistoricalCandle | null = null; for (const candle of candles) { if (candle.timestamp > timestamp) break; latest = candle } return latest }
function toFxSnapshot(baseCurrency: 'USD' | 'JPY', candle: HistoricalCandle, timestamp: string, source: 'HISTORICAL_FX'): FxRateSnapshot { return { baseCurrency, quoteCurrency: 'DKK', rate: candle.close, timestamp: candle.timestamp, source, status: 'LIVE', ageSeconds: Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(candle.timestamp)) / 1000)), diagnostic: 'DIRECT' } }
function toStrategyCandle(candle: HistoricalCandle, symbol: Symbol): Candle { return { ...candle, symbol } }
function alignToDay(candles: HistoricalCandle[], target: number, minimum = 1): number { if (candles.length <= 1) return candles.length; const clamped = Math.max(minimum, Math.min(candles.length - 1, target)); const date = utcDate(candles[clamped].timestamp); let index = clamped; while (index < candles.length && utcDate(candles[index].timestamp) === date) index += 1; return Math.min(index, candles.length - 1) }
function utcDate(timestamp: string): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp)) }
function splitTrades(trades: Record<DatasetSegment, Trade[]>, segment: DatasetSegment): Trade[] { return trades[segment] }
function annotateTrade(trade: Trade, timeframe: '5min' | '15min', segment: DatasetSegment) { trade.timeframe = timeframe; trade.datasetSegment = segment; trade.conversionMethod = 'HISTORICAL_FX'; trade.settingsSnapshot = undefined }
function emptyRejections(): BacktestRejections { return { NO_REJECTION: 0, NO_MSS: 0, NO_FVG: 0, NO_RETRACEMENT: 0, RR_BELOW_MINIMUM: 0, STALE_OR_MISSING_DATA: 0, POSITION_SIZE_INVALID: 0, SETUP_INVALIDATED: 0, SESSION_ENDED: 0 } }
function countRejection(message: string, counts: BacktestRejections) {
  const normalized = message.toLowerCase()

  if (normalized.includes('invalidated')) {
    counts.SETUP_INVALIDATED += 1
  } else if (normalized.includes('setup rejected because planned r:r')) {
    counts.RR_BELOW_MINIMUM += 1
  } else if (
    normalized.includes('position size') ||
    normalized.includes('calculated exposure')
  ) {
    counts.POSITION_SIZE_INVALID += 1
  } else if (
    normalized.includes('currency conversion unavailable') ||
    normalized.includes('conversion data is stale') ||
    normalized.includes('market data is')
  ) {
    counts.STALE_OR_MISSING_DATA += 1
  } else if (normalized.includes('waiting for mss')) {
    counts.NO_MSS += 1
  } else if (normalized.includes('waiting for a valid fvg')) {
    counts.NO_FVG += 1
  } else if (
    normalized.includes('waiting for midpoint retracement') ||
    normalized.includes('has not retraced to the configured entry zone')
  ) {
    counts.NO_RETRACEMENT += 1
  } else if (
    normalized.includes('waiting for a closed-candle rejection') ||
    normalized.includes('waiting for a closed rejection')
  ) {
    counts.NO_REJECTION += 1
  }
}
