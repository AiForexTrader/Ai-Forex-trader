import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBacktestMetrics, historicalFxAt, runBacktest, splitChronological } from './backtest'
import { defaultState } from '../storage/persistence'
import type { HistoricalCandle, Trade } from './types'

const historical = (symbol: string, timestamp: string, close: number): HistoricalCandle => ({ symbol, timestamp, open: close, high: close + 1, low: close - 1, close, interval: '5min', source: 'TWELVE_DATA', closed: true })
const fx = (symbol: string, timestamp: string, close: number): HistoricalCandle => ({ symbol, timestamp, open: close, high: close, low: close, close, interval: '5min', source: 'TWELVE_DATA', closed: true })

function completedTrade(id: string, pnl: number, r: number, winning: boolean, timestamp: string): Trade {
  const conversion = { baseCurrency: 'JPY' as const, quoteCurrency: 'DKK' as const, rate: 0.04, timestamp, source: 'HISTORICAL_FX', status: 'LIVE' as const, ageSeconds: 0, diagnostic: 'DIRECT' as const }
  return { id, symbol: 'USD/JPY', side: 'BUY', setupTimestamp: timestamp, entryTimestamp: timestamp, entryCandleTimestamp: timestamp, session: 'LONDON', entryPrice: 100, stopLoss: 99, takeProfit: 102, positionSize: 1, riskDkk: 100, plannedRr: 2, liquiditySweepDirection: 'LOW', asianHigh: 102, asianLow: 99, mssConfirmed: true, fvgBounds: { lower: 100, upper: 101 }, fvgMidpoint: 100.5, setupScore: 90, exitPrice: 102, exitReason: winning ? 'TAKE_PROFIT' : 'STOP_LOSS', pnlDkk: pnl, pnlR: r, winning, strategyVersion: 'ARS-MSS-FVG v2.0', setupId: id, exitTimestamp: new Date(Date.parse(timestamp) + 300000).toISOString(), grossPnlDkk: pnl, estimatedCostsDkk: 0, netPnlDkk: pnl, simulated: true, positionUnit: 'USD_UNITS', nativeCurrency: 'JPY', plannedRiskNative: 2500, entryConversion: conversion, exitConversion: conversion, nativePnl: pnl / 0.04, datasetSegment: 'OUT_OF_SAMPLE', timeframe: '5min' }
}

test('chronological split is ordered and keeps segments disjoint', () => {
  const candles = Array.from({ length: 40 }, (_, index) => historical('USD/JPY', new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 4), index % 4, 0)).toISOString(), index))
  const splits = splitChronological(candles)
  assert.equal(splits.length, 3)
  assert.ok(splits[0].candles.at(-1)!.timestamp < splits[1].candles[0].timestamp)
  assert.ok(splits[1].candles.at(-1)!.timestamp < splits[2].candles[0].timestamp)
})

test('historical FX uses rates at or before the candle and derives JPY/DKK safely', () => {
  const timestamp = '2026-01-01T10:00:00.000Z'
  const result = historicalFxAt(timestamp, [fx('USD/DKK', timestamp, 6.5)], [], [fx('USD/JPY', timestamp, 150)])
  assert.equal(result?.jpyDkk.rate, 6.5 / 150)
  assert.equal(result?.jpyDkk.diagnostic, 'DERIVED')
})

test('metrics calculate profit factor, expectancy, drawdown, and streaks', () => {
  const metrics = calculateBacktestMetrics([completedTrade('one', 200, 2, true, '2026-01-01T10:00:00.000Z'), completedTrade('two', -100, -1, false, '2026-01-02T10:00:00.000Z')])
  assert.equal(metrics.completedTrades, 2)
  assert.equal(metrics.profitFactor, 2)
  assert.equal(metrics.expectancyPerTrade, 50)
  assert.equal(metrics.maxDrawdown, 100)
  assert.equal(metrics.largestLosingStreak, 1)
})

test('backtest state and trades are isolated from live paper state', () => {
  const live = defaultState()
  const candle = historical('USD/JPY', '2026-01-01T10:00:00.000Z', 150)
  const market = { symbol: 'USD/JPY', interval: '5min' as const, provider: 'Twelve Data' as const, status: 'COMPLETE' as const, candles: [candle], requestedStart: candle.timestamp, requestedEnd: candle.timestamp, actualStart: candle.timestamp, actualEnd: candle.timestamp, missingIntervals: 0, complete: true }
  const result = runBacktest({ symbols: ['USD/JPY'], timeframe: '5min', marketData: { 'USD/JPY': market }, usdDkk: [fx('USD/DKK', candle.timestamp, 6.5)], jpyDkk: [fx('JPY/DKK', candle.timestamp, 0.043)], usdJpy: [], requestedStart: candle.timestamp, requestedEnd: candle.timestamp, settings: defaultState().settings })
  assert.equal(result.trades.length, 0)
  assert.equal(live.account.completedTrades.length, 0)
  assert.equal(live.account.balance, 10000)
})
