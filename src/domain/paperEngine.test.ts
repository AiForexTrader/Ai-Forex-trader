import assert from 'node:assert/strict'
import test from 'node:test'
import { getAsianSessionRange } from './marketData'
import { calculatePositionSize, DEFAULT_SETTINGS } from './paperTrading'
import { calculateGrossPnl, calculateNativePnl, detectFvgAfter, detectMss, detectRejection, detectSweep, hasRetraced, monitorOpenTrades, processMarketCycle } from './paperEngine'
import { defaultState } from '../storage/persistence'
import type { AsianRange, Candle, FxRatesResponse, LiquiditySweep, RejectionConfirmation, Trade } from './types'

const candle = (timestamp: string, open: number, high: number, low: number, close: number): Candle => ({ symbol: 'USD/JPY', timestamp, open, high, low, close, interval: '5min', source: 'TWELVE_DATA', closed: true })
const range: AsianRange = { sessionDate: '2026-09-23', timeZone: 'Asia/Tokyo', high: 100, low: 90, establishedAt: '2026-09-23T07:55:00.000Z' }
const sweepHigh: LiquiditySweep = { direction: 'HIGH', timestamp: '2026-09-23T08:00:00.000Z', extreme: 105, level: 100, distanceBeyondRange: 5, candleTimestamp: '2026-09-23T08:00:00.000Z' }
const sweepLow: LiquiditySweep = { direction: 'LOW', timestamp: '2026-09-23T08:00:00.000Z', extreme: 85, level: 90, distanceBeyondRange: 5, candleTimestamp: '2026-09-23T08:00:00.000Z' }
const highRejection: RejectionConfirmation = { direction: 'HIGH', timestamp: '2026-09-23T08:05:00.000Z', candleTimestamp: '2026-09-23T08:05:00.000Z', reclaimLevel: 100 }
const lowRejection: RejectionConfirmation = { direction: 'LOW', timestamp: '2026-09-23T08:05:00.000Z', candleTimestamp: '2026-09-23T08:05:00.000Z', reclaimLevel: 90 }
const fxRates: FxRatesResponse = { provider: 'Twelve Data', fetchedAt: '2026-09-23T08:00:00.000Z', usdDkk: { baseCurrency: 'USD', quoteCurrency: 'DKK', rate: 6.5, timestamp: '2026-09-23T08:00:00.000Z', source: 'Twelve Data', status: 'LIVE', ageSeconds: 0, diagnostic: 'DIRECT' }, jpyDkk: { baseCurrency: 'JPY', quoteCurrency: 'DKK', rate: 0.043, timestamp: '2026-09-23T08:00:00.000Z', source: 'Twelve Data', status: 'LIVE', ageSeconds: 0, diagnostic: 'DIRECT' } }

function trade(): Trade {
  return { id: 'test-trade', symbol: 'USD/JPY', side: 'BUY', setupTimestamp: '2026-09-23T08:00:00.000Z', entryTimestamp: '2026-09-23T08:00:00.000Z', entryCandleTimestamp: '2026-09-23T08:00:00.000Z', session: 'LONDON', entryPrice: 100, stopLoss: 95, takeProfit: 105, positionSize: 1, riskDkk: 5, plannedRr: 1, liquiditySweepDirection: 'LOW', asianHigh: 110, asianLow: 90, mssConfirmed: true, fvgBounds: { lower: 99, upper: 101 }, fvgMidpoint: 100, setupScore: 60, exitPrice: null, exitReason: null, pnlDkk: null, pnlR: null, winning: null, strategyVersion: 'test', setupId: 'test-setup', exitTimestamp: null, grossPnlDkk: null, estimatedCostsDkk: null, netPnlDkk: null, simulated: true, positionUnit: 'USD_UNITS', nativeCurrency: 'JPY', plannedRiskNative: 5, entryConversion: fxRates.jpyDkk, exitConversion: null, nativePnl: null }
}

test('Asian range uses only the latest Tokyo session', () => {
  const result = getAsianSessionRange([
    candle('2026-09-21T16:00:00.000Z', 1, 999, 1, 2),
    candle('2026-09-22T16:00:00.000Z', 1, 110, 90, 2),
    candle('2026-09-22T22:55:00.000Z', 2, 105, 95, 100),
  ])
  assert.deepEqual(result, { sessionDate: '2026-09-23', high: 110, low: 90, establishedAt: '2026-09-22T22:55:00.000Z' })
})

test('detects sweeps above high and below low', () => {
  assert.equal(detectSweep(candle('2026-09-23T08:00:00.000Z', 99, 101, 98, 100), range)?.direction, 'HIGH')
  assert.equal(detectSweep(candle('2026-09-23T08:00:00.000Z', 91, 92, 89, 90), range)?.direction, 'LOW')
})

test('requires a reclaim after the sweep', () => {
  assert.equal(detectRejection(candle('2026-09-23T08:05:00.000Z', 101, 102, 99, 100.5), sweepHigh, DEFAULT_SETTINGS), null)
  assert.equal(detectRejection(candle('2026-09-23T08:05:00.000Z', 101, 102, 99, 99.5), sweepHigh, DEFAULT_SETTINGS)?.direction, 'HIGH')
})

test('detects bullish and bearish MSS from a closed structural break', () => {
  const bearish = [candle('2026-09-23T08:10:00.000Z', 99, 100, 97, 98), candle('2026-09-23T08:15:00.000Z', 98, 99, 96, 97), candle('2026-09-23T08:20:00.000Z', 97, 98, 95, 96), candle('2026-09-23T08:25:00.000Z', 96, 97, 90, 91)]
  const bullish = bearish.map((item, index) => ({ ...item, open: 91, high: index === 3 ? 106 : 102, low: 90, close: index === 3 ? 105 : 101 }))
  assert.equal(detectMss(bearish, sweepHigh, highRejection)?.direction, 'SELL')
  assert.equal(detectMss(bullish, sweepLow, lowRejection)?.direction, 'BUY')
})

test('detects directional FVGs only after MSS and supports midpoint retracement', () => {
  const candles = [candle('2026-09-23T08:30:00.000Z', 96, 97, 94, 95), candle('2026-09-23T08:35:00.000Z', 93, 94, 91, 92), candle('2026-09-23T08:40:00.000Z', 90, 91, 88, 89)]
  const bearish = detectFvgAfter(candles, '2026-09-23T08:25:00.000Z', 'SELL', 0.1)
  assert.equal(bearish?.direction, 'SELL')
  assert.equal(hasRetraced(candle('2026-09-23T08:45:00.000Z', 92, 94, 89, 91), bearish!, DEFAULT_SETTINGS), true)
  const bullish = detectFvgAfter([candle('2026-09-23T08:30:00.000Z', 100, 101, 99, 100.5), candle('2026-09-23T08:35:00.000Z', 104, 105, 103, 104.5), candle('2026-09-23T08:40:00.000Z', 107, 108, 106, 107.5)], '2026-09-23T08:25:00.000Z', 'BUY', 0.1)
  assert.equal(bullish?.direction, 'BUY')
})

test('sizing is instrument-aware and never exceeds configured risk', () => {
  const result = calculatePositionSize('XAU/USD', 10000, 2000, 1990, 1, 6.5)
  assert.equal(result.available, true)
  assert.ok(result.positionSize * 10 * 6.5 <= result.riskDkk)
  const yenResult = calculatePositionSize('USD/JPY', 10000, 150, 149, 1, 0.043)
  assert.equal(yenResult.available, true)
  assert.ok(yenResult.positionSize * 0.043 <= yenResult.riskDkk)
  assert.equal(calculatePositionSize('USD/JPY', 10000, 150, 149, 1, null).available, false)
  assert.equal(calculatePositionSize('USD/JPY', 10000, 150, 149, 1, 0).available, false)
  assert.equal(calculatePositionSize('USD/JPY', 10000, 150, 149, 1, Number.NaN).available, false)
  assert.equal(calculatePositionSize('USD/JPY', 10000, 150, 149, 1, Number.POSITIVE_INFINITY).available, false)
})

test('stale data cannot create a trade and duplicate candles are ignored', () => {
  const first = processMarketCycle({ state: defaultState(), symbol: 'USD/JPY', candles: [candle('2026-09-23T08:00:00.000Z', 100, 101, 99, 100)], marketStatus: 'LIVE', session: 'LONDON', asianRange: range, fxRates: null, now: '2026-09-23T08:05:00.000Z' })
  const second = processMarketCycle({ ...({ state: first.state, symbol: 'USD/JPY', candles: [candle('2026-09-23T08:00:00.000Z', 100, 101, 99, 100)], marketStatus: 'LIVE', session: 'LONDON', asianRange: range, fxRates: null, now: '2026-09-23T08:06:00.000Z' }) })
  const stale = processMarketCycle({ state: defaultState(), symbol: 'USD/JPY', candles: [candle('2026-09-23T08:00:00.000Z', 100, 101, 99, 100)], marketStatus: 'STALE', session: 'LONDON', asianRange: range, fxRates: null, now: '2026-09-23T08:05:00.000Z' })
  assert.equal(second.state.journal.length, first.state.journal.length)
  assert.equal(stale.state.account.openTrades.length, 0)
})

test('automatic entry uses one setup ID only once', () => {
  const state = defaultState()
  const tradeRange = { ...range, high: 110 }
  state.settings.quoteToDkk['USD/JPY'] = 1
  state.strategyStates['USD/JPY'] = {
    ...state.strategyStates['USD/JPY'], state: 'WAITING_FOR_RETRACEMENT', sessionDate: tradeRange.sessionDate, asianRange: tradeRange,
    sweep: sweepLow, rejection: lowRejection, mss: { direction: 'BUY', structureLevel: 95, confirmationCandle: '2026-09-23T08:25:00.000Z', confirmationTimestamp: '2026-09-23T08:25:00.000Z', displacementSize: 3 },
    fvg: { lower: 91, upper: 94, midpoint: 92.5, direction: 'BUY', formedAt: '2026-09-23T08:40:00.000Z' }, setupId: 'USD/JPY|2026-09-23|LOW|2026-09-23T08:00:00.000Z|2026-09-23T08:25:00.000Z|2026-09-23T08:40:00.000Z', lastProcessedCandle: '2026-09-23T08:40:00.000Z', plannedRr: null, riskDkk: null,
  }
  const input = { state, symbol: 'USD/JPY' as const, candles: [candle('2026-09-23T08:45:00.000Z', 93, 94, 91, 92.5)], marketStatus: 'LIVE' as const, session: 'LONDON' as const, asianRange: tradeRange, fxRates, now: '2026-09-23T08:45:00.000Z' }
  const rrState = structuredClone(state)
  rrState.strategyStates['USD/JPY'].asianRange = { ...tradeRange, high: 95 }
  const rejected = processMarketCycle({ ...input, state: rrState, asianRange: { ...tradeRange, high: 95 } })
  assert.equal(rejected.opened, null)
  assert.equal(rejected.state.journal.some(entry => entry.includes('below required')), true)
  const first = processMarketCycle(input)
  assert.equal(first.opened?.setupId, state.strategyStates['USD/JPY'].setupId)
  const second = processMarketCycle({ ...input, state: first.state, now: '2026-09-23T08:50:00.000Z' })
  assert.equal(second.state.account.openTrades.length, 1)
})

test('ambiguous candle exits conservatively instead of assuming TP', () => {
  const state = defaultState()
  state.settings.quoteToDkk['USD/JPY'] = 1
  state.account.openTrades = [trade()]
  const closed = monitorOpenTrades(state, 'USD/JPY', candle('2026-09-23T09:00:00.000Z', 100, 106, 94, 100), state.settings, fxRates.jpyDkk)
  assert.equal(closed.length, 1)
  assert.equal(closed[0].exitReason, 'AMBIGUOUS_INTRABAR')
  assert.equal(closed[0].exitPrice, 95)
  assert.equal(state.account.openTrades.length, 0)
})

test('native P/L converts with the stored instrument rate', () => {
  const yenTrade = trade()
  assert.equal(calculateNativePnl(yenTrade, 101), 1)
  assert.equal(calculateGrossPnl(yenTrade, 101, DEFAULT_SETTINGS, fxRates.jpyDkk), 0.043)
  const goldTrade = { ...yenTrade, symbol: 'XAU/USD' as const, positionSize: 2, entryPrice: 2000, entryConversion: fxRates.usdDkk }
  assert.equal(calculateNativePnl(goldTrade, 2010), 20)
  assert.equal(calculateGrossPnl(goldTrade, 2010, DEFAULT_SETTINGS, fxRates.usdDkk), 130)
})

test('stale conversion blocks a retraced entry', () => {
  const state = defaultState()
  const tradeRange = { ...range, high: 110 }
  state.strategyStates['USD/JPY'] = { ...state.strategyStates['USD/JPY'], state: 'WAITING_FOR_RETRACEMENT', sessionDate: tradeRange.sessionDate, asianRange: tradeRange, sweep: sweepLow, rejection: lowRejection, mss: { direction: 'BUY', structureLevel: 95, confirmationCandle: '2026-09-23T08:25:00.000Z', confirmationTimestamp: '2026-09-23T08:25:00.000Z', displacementSize: 3 }, fvg: { lower: 91, upper: 94, midpoint: 92.5, direction: 'BUY', formedAt: '2026-09-23T08:40:00.000Z' }, setupId: 'stale-setup', lastProcessedCandle: '2026-09-23T08:40:00.000Z', plannedRr: null, riskDkk: null }
  const staleRates = structuredClone(fxRates)
  staleRates.jpyDkk = { ...staleRates.jpyDkk, status: 'STALE', ageSeconds: 181 }
  const result = processMarketCycle({ state, symbol: 'USD/JPY', candles: [candle('2026-09-23T08:45:00.000Z', 93, 94, 91, 92.5)], marketStatus: 'LIVE', session: 'LONDON', asianRange: tradeRange, fxRates: staleRates, now: '2026-09-23T08:45:00.000Z' })
  assert.equal(result.opened, null)
  assert.equal(result.state.journal.some(entry => entry.includes('conversion data is stale')), true)
})

test('completed trade retains entry and exit conversion snapshots', () => {
  const state = defaultState()
  state.account.openTrades = [trade()]
  const exitRates = structuredClone(fxRates)
  exitRates.jpyDkk = { ...exitRates.jpyDkk, rate: 0.05 }
  const closed = monitorOpenTrades(state, 'USD/JPY', candle('2026-09-23T09:00:00.000Z', 100, 106, 99, 105), state.settings, exitRates.jpyDkk)
  assert.equal(closed[0].entryConversion.rate, fxRates.jpyDkk.rate)
  assert.equal(closed[0].exitConversion?.rate, 0.05)
  assert.equal(closed[0].netPnlDkk, 5 * 0.05)
})

test('updates sweep extreme before rejection when price makes a deeper sweep', () => {
  const state = defaultState()

  const first = processMarketCycle({
    state,
    symbol: 'USD/JPY',
    candles: [
      candle('2026-09-23T08:00:00.000Z', 91, 92, 89, 89.5)
    ],
    marketStatus: 'LIVE',
    session: 'LONDON',
    asianRange: range,
    fxRates,
    now: '2026-09-23T08:00:00.000Z'
  })

  assert.equal(first.state.strategyStates['USD/JPY'].sweep?.extreme, 89)

  const second = processMarketCycle({
    state: first.state,
    symbol: 'USD/JPY',
    candles: [
      candle('2026-09-23T08:00:00.000Z', 91, 92, 89, 89.5),
      candle('2026-09-23T08:05:00.000Z', 89.5, 90, 87, 88)
    ],
    marketStatus: 'LIVE',
    session: 'LONDON',
    asianRange: range,
    fxRates,
    now: '2026-09-23T08:05:00.000Z'
  })

  assert.equal(second.state.strategyStates['USD/JPY'].sweep?.extreme, 87)
})

test('invalidated setup does not repeat on the next candle', () => {
  const state = defaultState()
  const strategy = state.strategyStates['USD/JPY']

  strategy.sessionDate = range.sessionDate
  strategy.asianRange = range
  strategy.sweep = {
    direction: 'LOW',
    timestamp: '2026-09-23T08:00:00.000Z',
    extreme: 85,
    level: 90,
    distanceBeyondRange: 5,
    candleTimestamp: '2026-09-23T08:00:00.000Z'
  }
  strategy.rejection = lowRejection
  strategy.mss = {
    direction: 'BUY',
    structureLevel: 95,
    confirmationCandle: '2026-09-23T08:25:00.000Z',
    confirmationTimestamp: '2026-09-23T08:25:00.000Z',
    displacementSize: 5
  }
  strategy.fvg = {
    lower: 96,
    upper: 98,
    midpoint: 97,
    direction: 'BUY',
    formedAt: '2026-09-23T08:40:00.000Z'
  }
  strategy.setupId = 'invalidation-test'

  const first = processMarketCycle({
    state,
    symbol: 'USD/JPY',
    candles: [
      candle('2026-09-23T08:45:00.000Z', 86, 87, 83, 84)
    ],
    marketStatus: 'LIVE',
    session: 'LONDON',
    asianRange: range,
    fxRates,
    now: '2026-09-23T08:45:00.000Z'
  })

  assert.match(first.journalEntry ?? '', /invalidated/i)

  const second = processMarketCycle({
    state: first.state,
    symbol: 'USD/JPY',
    candles: [
      candle('2026-09-23T08:45:00.000Z', 86, 87, 83, 84),
      candle('2026-09-23T08:50:00.000Z', 84, 85, 82, 83)
    ],
    marketStatus: 'LIVE',
    session: 'LONDON',
    asianRange: range,
    fxRates,
    now: '2026-09-23T08:50:00.000Z'
  })

  assert.doesNotMatch(second.journalEntry ?? '', /invalidated/i)
})
