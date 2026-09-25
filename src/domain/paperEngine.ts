import { calculatePositionSize } from './paperTrading'
import { calculateStrategyStats } from './research'
import { conversionForSymbol } from './fxRates'
import type { AsianRange, Candle, Fvg, FxRateSnapshot, FxRatesResponse, LiquiditySweep, MarketDataStatus, MssConfirmation, PersistedState, RejectionConfirmation, Session, Side, StrategySettings, StrategySnapshot, StrategyState, Symbol, Trade } from './types'

export interface EngineInput {
  state: PersistedState
  symbol: Symbol
  candles: Candle[]
  marketStatus: MarketDataStatus
  session: Session
  asianRange: AsianRange | null
  fxRates: FxRatesResponse | null
  now: string
  historicalReplay?: boolean
}

export interface EngineResult {
  state: PersistedState
  snapshot: StrategySnapshot
  opened: Trade | null
  closed: Trade[]
  journalEntry: string | null
}

export function processMarketCycle(input: EngineInput): EngineResult {
  const next = cloneState(input.state)
  const settings = next.settings
  const strategy = next.strategyStates[input.symbol]
  const previousJournalLength = next.journal.length
  const latest = input.candles.at(-1)
  const openForSymbol = next.account.openTrades.filter(trade => trade.symbol === input.symbol)
  let journalEntry: string | null = null

  if (input.marketStatus !== 'LIVE' || !latest || !latest.closed) {
    strategy.state = 'DATA_UNAVAILABLE'
    const message = appendJournal(next, strategy, `${input.symbol}: market data is ${input.marketStatus.toLowerCase()}; no new paper entry or exit was evaluated.`, `data-${input.marketStatus}`)
    return finish(next, input, message, null, [])
  }

  if (strategy.lastProcessedCandle === latest.timestamp) return finish(next, input, null, null, [])
  strategy.lastProcessedCandle = latest.timestamp

  const conversion = conversionForSymbol(input.fxRates, input.symbol)
  const closed = monitorOpenTrades(next, input.symbol, latest, settings, conversion)
  for (const trade of closed) {
    journalEntry = appendJournal(next, strategy, `${input.symbol}: PAPER trade closed with ${trade.exitReason}. Net result: ${(trade.netPnlDkk ?? 0).toFixed(2)} DKK.`, `exit-${trade.id}-${trade.exitTimestamp}`) ?? journalEntry
  }
  const activeAfterExit = next.account.openTrades.some(trade => trade.symbol === input.symbol)
  if (closed.length) {
    strategy.state = 'COOLDOWN'
    strategy.cooldownUntil = new Date(Date.parse(input.now) + settings.cooldownMinutes * 60_000).toISOString()
  }

  if (input.asianRange && strategy.sessionDate !== input.asianRange.sessionDate) {
    strategy.sessionDate = input.asianRange.sessionDate
    strategy.asianRange = input.asianRange
    strategy.sweep = null
    strategy.rejection = null
    strategy.mss = null
    strategy.fvg = null
    strategy.plannedRr = null
    strategy.riskDkk = null
    strategy.setupId = null
    if (!activeAfterExit) strategy.state = 'WATCHING'
    appendJournal(next, strategy, `${input.symbol}: Asian range established at ${input.asianRange.high.toFixed(5)} / ${input.asianRange.low.toFixed(5)} for ${input.asianRange.sessionDate}.`, `range-${input.asianRange.sessionDate}`)
  }

  if (!input.asianRange) {
    strategy.state = 'WAITING_FOR_ASIAN_RANGE'
    const message = appendJournal(next, strategy, `${input.symbol}: waiting for a complete Asian range from genuine closed candles.`, 'waiting-asian-range')
    return finish(next, input, message, null, closed)
  }

  if (activeAfterExit || next.account.openTrades.some(trade => trade.symbol === input.symbol)) {
    strategy.state = 'TRADE_ACTIVE'
    return finish(next, input, null, null, closed)
  }

  if (strategy.cooldownUntil && Date.parse(input.now) < Date.parse(strategy.cooldownUntil)) {
    strategy.state = 'COOLDOWN'
    return finish(next, input, null, null, closed)
  }
  strategy.cooldownUntil = null

  if (input.session !== 'LONDON' && input.session !== 'LONDON / NY OVERLAP') {
    strategy.state = 'WATCHING'
    return finish(next, input, null, null, closed)
  }

  if (!strategy.sweep) {
    const sweep = detectSweep(latest, input.asianRange)
    if (!sweep) {
      strategy.state = 'WATCHING'
      journalEntry = appendJournal(next, strategy, `${input.symbol}: watching for a confirmed liquidity sweep.`, `watching-${input.asianRange.sessionDate}`)
    } else {
      strategy.sweep = sweep
      strategy.state = 'WAITING_FOR_REJECTION'
      journalEntry = appendJournal(next, strategy, `${input.symbol}: price swept the Asian ${sweep.direction === 'HIGH' ? 'high' : 'low'}; waiting for a closed-candle rejection/reclaim.`, `sweep-${sweep.timestamp}`)
    }
  } else if (!strategy.rejection) {
    const newerSweep = detectSweep(latest, input.asianRange)

    if (
      newerSweep &&
      newerSweep.direction === strategy.sweep.direction &&
      (
        (newerSweep.direction === 'HIGH' && newerSweep.extreme > strategy.sweep.extreme) ||
        (newerSweep.direction === 'LOW' && newerSweep.extreme < strategy.sweep.extreme)
      )
    ) {
      strategy.sweep = newerSweep
    }

    const rejection = detectRejection(latest, strategy.sweep, settings)
    strategy.state = rejection ? 'WAITING_FOR_MSS' : 'WAITING_FOR_REJECTION'
    if (rejection) {
      strategy.rejection = rejection
      journalEntry = appendJournal(next, strategy, `${input.symbol}: ${rejection.direction === 'HIGH' ? 'bearish' : 'bullish'} reclaim confirmed; waiting for MSS.`, `rejection-${rejection.timestamp}`)
    }
  } else if (!strategy.mss) {
    const mss = detectMss(input.candles, strategy.sweep, strategy.rejection)
    strategy.state = mss ? 'WAITING_FOR_FVG' : 'WAITING_FOR_MSS'
    if (mss) {
      strategy.mss = mss
      journalEntry = appendJournal(next, strategy, `${input.symbol}: ${mss.direction === 'BUY' ? 'bullish' : 'bearish'} MSS confirmed at ${mss.structureLevel.toFixed(5)}; waiting for a valid FVG.`, `mss-${mss.confirmationTimestamp}`)
    }
  } else if (!strategy.fvg) {
    const fvg = detectFvgAfter(input.candles, strategy.mss.confirmationTimestamp, strategy.mss.direction, settings.minimumFvgSize[input.symbol])
    strategy.state = fvg ? 'WAITING_FOR_RETRACEMENT' : 'WAITING_FOR_FVG'
    if (fvg) {
      strategy.fvg = fvg
      strategy.setupId = createSetupId(input.symbol, input.asianRange.sessionDate, strategy.sweep, strategy.mss, fvg)
      journalEntry = appendJournal(next, strategy, `${input.symbol}: valid ${fvg.direction === 'BUY' ? 'bullish' : 'bearish'} FVG detected; waiting for midpoint retracement.`, `fvg-${fvg.formedAt}`)
    }
  } else {
    const invalidated = strategy.sweep.direction === 'LOW' ? latest.close < strategy.sweep.extreme : latest.close > strategy.sweep.extreme
    if (invalidated) {
      strategy.state = 'COOLDOWN'
      strategy.cooldownUntil = new Date(
        Date.parse(input.now) + settings.cooldownMinutes * 60_000
      ).toISOString()
      next.usedSetupIds = strategy.setupId
        ? [...new Set([...next.usedSetupIds, strategy.setupId])]
        : next.usedSetupIds
      journalEntry = appendJournal(
        next,
        strategy,
        `${input.symbol}: setup invalidated before entry because price exceeded the liquidity-sweep extreme.`,
        `invalidated-${strategy.setupId}-${latest.timestamp}`
      )
      return finish(next, input, journalEntry, null, closed, previousJournalLength)
    }
    const retraced = hasRetraced(latest, strategy.fvg, settings)
    if (!retraced) {
      strategy.state = 'WAITING_FOR_RETRACEMENT'
      journalEntry = appendJournal(next, strategy, `${input.symbol}: FVG exists but price has not retraced to the configured entry zone.`, `retracement-wait-${strategy.fvg.formedAt}`)
    } else {
      strategy.state = 'ENTRY_READY'
      const conversion = conversionForSymbol(input.fxRates, input.symbol)
      if (!conversion || conversion.rate === null || !Number.isFinite(conversion.rate) || conversion.rate <= 0) {
        journalEntry = appendJournal(next, strategy, `${input.symbol}: Entry blocked: currency conversion unavailable.`, `fx-unavailable-${strategy.setupId}`)
        return finish(next, input, journalEntry, null, closed, previousJournalLength)
      }
      if (!isConversionUsable(conversion, settings, input.historicalReplay === true)) {
        journalEntry = appendJournal(next, strategy, `${input.symbol}: Entry blocked: currency conversion data is stale.`, `fx-stale-${strategy.setupId}`)
        return finish(next, input, journalEntry, null, closed, previousJournalLength)
      }
      const tradePlan = buildTradePlan(input.symbol, strategy, input.asianRange, settings, next.account.equity, conversion)
      strategy.plannedRr = tradePlan.plannedRr
      strategy.riskDkk = tradePlan.sizing.riskDkk
      if (!tradePlan.valid) {
        journalEntry = appendJournal(next, strategy, `${input.symbol}: setup rejected because planned R:R is ${tradePlan.plannedRr.toFixed(2)}, below required ${settings.minimumRr.toFixed(2)}.`, `rr-rejected-${strategy.setupId}`)
        strategy.state = 'COOLDOWN'
        strategy.cooldownUntil = new Date(Date.parse(input.now) + settings.cooldownMinutes * 60_000).toISOString()
      } else if (!tradePlan.sizing.available) {
        journalEntry = appendJournal(next, strategy, `${input.symbol}: POSITION SIZE UNAVAILABLE; the calculated exposure could not satisfy the configured risk constraints.`, `sizing-unavailable-${strategy.setupId}`)
      } else if (settings.newsStatus === 'NEWS BLOCK ACTIVE') {
        journalEntry = appendJournal(next, strategy, `${input.symbol}: entry blocked because the news filter is active.`, `news-block-${strategy.setupId}`)
      } else if (next.usedSetupIds.includes(strategy.setupId!)) {
        strategy.state = 'COOLDOWN'
      } else if (next.account.openTrades.length >= settings.maxOpenTrades) {
        journalEntry = appendJournal(next, strategy, `${input.symbol}: entry ready, but maximum simultaneous paper trades has been reached.`, `max-open-${strategy.setupId}`)
      } else {
        const trade = createEngineTrade(input, strategy, tradePlan)
        next.account.openTrades.push(trade)
        next.usedSetupIds.push(trade.setupId)
        strategy.state = 'TRADE_ACTIVE'
        journalEntry = appendJournal(next, strategy, `${input.symbol}: PAPER ${trade.side} opened at ${trade.entryPrice.toFixed(5)}. Risk: ${trade.riskDkk.toFixed(2)} DKK.`, `opened-${trade.setupId}`)
      }
    }
  }

  next.account.equity = calculateEquity(next.account.balance, next.account.openTrades)
  return finish(next, input, journalEntry, next.account.openTrades.find(trade => trade.setupId === strategy.setupId) ?? null, closed, previousJournalLength)
}

export function detectSweep(candle: Candle, range: AsianRange): LiquiditySweep | null {
  if (candle.timestamp <= range.establishedAt) return null
  if (candle.high > range.high) return { direction: 'HIGH', timestamp: candle.timestamp, extreme: candle.high, level: range.high, distanceBeyondRange: candle.high - range.high, candleTimestamp: candle.timestamp }
  if (candle.low < range.low) return { direction: 'LOW', timestamp: candle.timestamp, extreme: candle.low, level: range.low, distanceBeyondRange: range.low - candle.low, candleTimestamp: candle.timestamp }
  return null
}

export function detectRejection(candle: Candle, sweep: LiquiditySweep, settings: StrategySettings): RejectionConfirmation | null {
  const reclaimed = sweep.direction === 'HIGH' ? candle.close < sweep.level : candle.close > sweep.level
  return reclaimed ? { direction: sweep.direction, timestamp: candle.timestamp, candleTimestamp: candle.timestamp, reclaimLevel: sweep.level } : null
}

export function detectMss(candles: Candle[], sweep: LiquiditySweep, rejection: RejectionConfirmation): MssConfirmation | null {
  // Only the latest 4 candles after rejection are needed.
  // Walk backwards instead of filtering the complete replay history.
  const recent: Candle[] = []

  for (let i = candles.length - 1; i >= 0 && recent.length < 4; i -= 1) {
    const candle = candles[i]
    if (candle.timestamp <= rejection.timestamp) break
    recent.push(candle)
  }

  if (recent.length < 4) return null
  recent.reverse()

  const latest = recent[3]
  const structure = recent.slice(0, 3)

  if (sweep.direction === 'HIGH') {
    const level = Math.min(...structure.map(candle => candle.low))
    return latest.close < level
      ? {
          direction: 'SELL',
          structureLevel: level,
          confirmationCandle: latest.timestamp,
          confirmationTimestamp: latest.timestamp,
          displacementSize: Math.abs(latest.close - latest.open)
        }
      : null
  }

  const level = Math.max(...structure.map(candle => candle.high))
  return latest.close > level
    ? {
        direction: 'BUY',
        structureLevel: level,
        confirmationCandle: latest.timestamp,
        confirmationTimestamp: latest.timestamp,
        displacementSize: Math.abs(latest.close - latest.open)
      }
    : null
}

export function detectFvgAfter(candles: Candle[], afterTimestamp: string, direction: Side, minimumSize: number): Fvg | null {
  // Only the latest 3 candles after MSS are needed.
  const recent: Candle[] = []

  for (let i = candles.length - 1; i >= 0 && recent.length < 3; i -= 1) {
    const candle = candles[i]
    if (candle.timestamp <= afterTimestamp) break
    recent.push(candle)
  }

  if (recent.length < 3) return null
  recent.reverse()

  const first = recent[0]
  const third = recent[2]

  const lower = direction === 'BUY' ? first.high : third.high
  const upper = direction === 'BUY' ? third.low : first.low

  if (!(upper > lower) || upper - lower < minimumSize) return null

  return {
    lower,
    upper,
    midpoint: (lower + upper) / 2,
    direction,
    formedAt: third.timestamp
  }
}

export function hasRetraced(candle: Candle, fvg: Fvg, settings: StrategySettings): boolean {
  const tolerance = (fvg.upper - fvg.lower) * settings.fvgTolerance
  return candle.timestamp > fvg.formedAt && candle.low <= fvg.midpoint + tolerance && candle.high >= fvg.midpoint - tolerance
}

function createSetupId(symbol: Symbol, sessionDate: string, sweep: LiquiditySweep, mss: MssConfirmation, fvg: Fvg): string {
  return [symbol, sessionDate, sweep.direction, sweep.timestamp, mss.confirmationTimestamp, fvg.formedAt].join('|')
}

function buildTradePlan(symbol: Symbol, strategy: StrategyState, range: AsianRange, settings: StrategySettings, equity: number, conversion: FxRateSnapshot) {
  const side = strategy.mss!.direction
  const entry = strategy.fvg!.midpoint
  const stopLoss = side === 'BUY' ? strategy.sweep!.extreme - settings.stopSafetyBuffer : strategy.sweep!.extreme + settings.stopSafetyBuffer
  const target = side === 'BUY' ? range.high : range.low
  const riskDistance = Math.abs(entry - stopLoss)
  const rewardDistance = side === 'BUY' ? target - entry : entry - target
  const plannedRr = riskDistance > 0 && rewardDistance > 0 ? rewardDistance / riskDistance : 0
  const sizing = calculatePositionSize(symbol, equity, entry, stopLoss, settings.riskPercent, conversion.rate)
  return { valid: Number.isFinite(plannedRr) && plannedRr >= settings.minimumRr, plannedRr, entry, stopLoss, target, sizing, conversion }
}

function createEngineTrade(input: EngineInput, strategy: StrategyState, plan: ReturnType<typeof buildTradePlan>): Trade {
  const side = strategy.mss!.direction
  const sizing = calculatePositionSize(input.symbol, input.state.account.equity, plan.entry, plan.stopLoss, input.state.settings.riskPercent, plan.conversion.rate)
  const setupId = strategy.setupId!
  const setupScore = 15 + 15 + 20 + 20 + 20 + (input.session === 'LONDON' || input.session === 'LONDON / NY OVERLAP' ? 10 : 0)
  return { id: `paper-${setupId}`, symbol: input.symbol, side, setupTimestamp: strategy.fvg!.formedAt, entryTimestamp: input.now, entryCandleTimestamp: input.candles.at(-1)!.timestamp, session: input.session, entryPrice: plan.entry, stopLoss: plan.stopLoss, takeProfit: plan.target, positionSize: sizing.positionSize, riskDkk: sizing.riskDkk, plannedRr: plan.plannedRr, liquiditySweepDirection: strategy.sweep!.direction, asianHigh: strategy.asianRange!.high, asianLow: strategy.asianRange!.low, mssConfirmed: true, fvgBounds: { lower: strategy.fvg!.lower, upper: strategy.fvg!.upper }, fvgMidpoint: strategy.fvg!.midpoint, setupScore, exitPrice: null, exitReason: null, pnlDkk: null, pnlR: null, winning: null, strategyVersion: input.state.settings.strategyVersion, setupId, exitTimestamp: null, grossPnlDkk: null, estimatedCostsDkk: 0, netPnlDkk: null, simulated: true, positionUnit: input.symbol === 'XAU/USD' ? 'OUNCES' : 'USD_UNITS', nativeCurrency: input.symbol === 'XAU/USD' ? 'USD' : 'JPY', plannedRiskNative: sizing.nativeRisk, entryConversion: plan.conversion, exitConversion: null, nativePnl: null }
}

export function monitorOpenTrades(state: PersistedState, symbol: Symbol, candle: Candle, settings: StrategySettings, conversion: FxRateSnapshot | null): Trade[] {
  const closed: Trade[] = []
  for (const trade of [...state.account.openTrades]) {
    if (trade.symbol !== symbol) continue
    const hitStop = trade.side === 'BUY' ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss
    const hitTarget = trade.side === 'BUY' ? candle.high >= trade.takeProfit : candle.low <= trade.takeProfit
    if (!hitStop && !hitTarget) {
      trade.currentPrice = candle.close
      if (isConversionUsable(conversion, settings)) {
        trade.currentPnlDkk = calculateGrossPnl(trade, candle.close, settings, conversion)
        trade.currentR = trade.riskDkk ? trade.currentPnlDkk / trade.riskDkk : 0
      }
      continue
    }
    if (!isConversionUsable(conversion, settings)) continue
    const ambiguous = hitStop && hitTarget
    const exitPrice = ambiguous ? trade.stopLoss : hitTarget ? trade.takeProfit : trade.stopLoss
    closeTrade(state, trade, exitPrice, ambiguous ? 'AMBIGUOUS_INTRABAR' : hitTarget ? 'TAKE_PROFIT' : 'STOP_LOSS', candle.timestamp, settings, conversion)
    closed.push(trade)
  }
  return closed
}

function closeTrade(state: PersistedState, trade: Trade, exitPrice: number, reason: Trade['exitReason'], timestamp: string, settings: StrategySettings, conversion: FxRateSnapshot) {
  trade.exitPrice = exitPrice
  trade.exitReason = reason
  trade.exitTimestamp = timestamp
  trade.nativePnl = calculateNativePnl(trade, exitPrice)
  trade.exitConversion = conversion
  trade.grossPnlDkk = trade.nativePnl * conversion.rate!
  trade.estimatedCostsDkk = calculateCosts(trade, settings, conversion)
  trade.netPnlDkk = trade.grossPnlDkk - trade.estimatedCostsDkk
  trade.pnlDkk = trade.netPnlDkk
  trade.pnlR = trade.riskDkk ? trade.netPnlDkk / trade.riskDkk : null
  trade.winning = trade.netPnlDkk > 0
  state.account.openTrades = state.account.openTrades.filter(open => open.id !== trade.id)
  state.account.completedTrades.push(trade)
  state.account.balance += trade.netPnlDkk
  state.account.dailyPnl += trade.netPnlDkk
  state.account.stats = calculateStrategyStats(state.account.completedTrades)
}

export function calculateNativePnl(trade: Trade, exitPrice: number): number {
  const delta = trade.side === 'BUY' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice
  return delta * trade.positionSize
}

export function calculateGrossPnl(trade: Trade, exitPrice: number, settings: StrategySettings, conversion: FxRateSnapshot): number {
  return calculateNativePnl(trade, exitPrice) * conversion.rate!
}

function calculateCosts(trade: Trade, settings: StrategySettings, conversion: FxRateSnapshot): number {
  const friction = settings.spread[trade.symbol] + settings.slippage[trade.symbol]
  return friction * 2 * trade.positionSize * conversion.rate!
}

function isConversionUsable(
  conversion: FxRateSnapshot | null,
  settings: StrategySettings,
  historicalReplay = false
): conversion is FxRateSnapshot & { rate: number; ageSeconds: number } {
  if (
    !conversion ||
    (conversion.status !== 'LIVE' && conversion.status !== 'STALE') ||
    conversion.rate === null ||
    !Number.isFinite(conversion.rate) ||
    conversion.rate <= 0 ||
    !conversion.timestamp ||
    conversion.ageSeconds === null
  ) {
    return false
  }

  // Historical backtests use the most recent real FX candle at or
  // before the replay timestamp. The live 180-second rule does not
  // apply to historical replay.
  if (historicalReplay) return true

  return conversion.ageSeconds <= settings.maxFxAgeSeconds
}

function calculateEquity(balance: number, trades: Trade[]): number {
  return balance + trades.reduce((sum, trade) => sum + (trade.currentPnlDkk ?? 0), 0)
}

function appendJournal(state: PersistedState, strategy: StrategyState, message: string, key: string): string | null {
  if (strategy.lastJournalKey === key) return null
  strategy.lastJournalKey = key
  state.journal.push(`${new Date().toISOString()} ${message}`)
  return message
}

function cloneState(state: PersistedState): PersistedState {
  return JSON.parse(JSON.stringify(state)) as PersistedState
}

function finish(state: PersistedState, input: EngineInput, journalEntry: string | null, opened: Trade | null, closed: Trade[], previousJournalLength = state.journal.length): EngineResult {
  const strategy = state.strategyStates[input.symbol]
  const snapshot = toSnapshot(
    strategy,
    input.session,
    journalEntry ?? strategy.snapshot?.journal ?? ''
  )
  state.strategyStates[input.symbol].snapshot = snapshot
  state.account.equity = calculateEquity(state.account.balance, state.account.openTrades)
  return { state, snapshot, opened, closed, journalEntry: state.journal.length > previousJournalLength ? state.journal.at(-1)! : journalEntry }
}

function toSnapshot(strategy: StrategyState, session: Session, journal: string): StrategySnapshot {
  const direction = strategy.sweep?.direction
  const decision = strategy.state === 'TRADE_ACTIVE' ? 'TRADE ACTIVE' : strategy.state === 'ENTRY_READY' ? (strategy.mss?.direction === 'BUY' ? 'PAPER BUY' : 'PAPER SELL') : strategy.state === 'WAITING_FOR_RETRACEMENT' ? 'WAIT FOR RETRACEMENT' : strategy.state === 'WAITING_FOR_FVG' ? 'WAITING FOR FVG' : strategy.state === 'WAITING_FOR_MSS' ? 'WAITING FOR MSS' : strategy.state === 'WAITING_FOR_REJECTION' ? 'WAITING FOR REJECTION' : strategy.state === 'SWEEP_DETECTED' ? 'LIQUIDITY SWEPT' : 'WATCHING'
  const setupScore = strategy.fvg ? 15 + 15 + 20 + 20 + (strategy.state === 'ENTRY_READY' || strategy.state === 'TRADE_ACTIVE' ? 20 : 0) + (session === 'LONDON' || session === 'LONDON / NY OVERLAP' ? 10 : 0) : null
  return { symbol: strategy.symbol, session, asianHigh: strategy.asianRange?.high ?? null, asianLow: strategy.asianRange?.low ?? null, decision, setupScore, liquiditySweep: direction ? strategy.rejection ? 'CONFIRMED' : direction === 'HIGH' ? 'HIGH SWEPT' : 'LOW SWEPT' : 'WAITING', mss: strategy.mss ? 'CONFIRMED' : '—', fvg: strategy.fvg, plannedRr: strategy.plannedRr, journal, state: strategy.state, rejection: strategy.rejection ? 'CONFIRMED' : strategy.sweep ? 'WAITING' : '—', retracement: strategy.state === 'ENTRY_READY' || strategy.state === 'TRADE_ACTIVE' ? 'REACHED' : strategy.fvg ? 'WAITING' : '—', riskDkk: strategy.riskDkk, setupId: strategy.setupId }
}
