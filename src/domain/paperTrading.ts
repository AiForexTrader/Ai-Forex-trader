import type { AccountState, Side, Symbol, Trade } from './types'

export const INITIAL_BALANCE = 10000
export const DEFAULT_SETTINGS = {
  riskPercent: 1, maxOpenTrades: 2, minimumRr: 2, fvgRetracementTarget: 0.5, fvgTolerance: 0.1,
  stopSafetyBuffer: 0.05, cooldownMinutes: 60, strategyInterval: '5min' as const,
  minimumFvgSize: { 'XAU/USD': 0.1, 'USD/JPY': 0.01 }, reclaimBars: 3,
  quoteToDkk: { 'XAU/USD': null, 'USD/JPY': null }, spread: { 'XAU/USD': 0, 'USD/JPY': 0 }, slippage: { 'XAU/USD': 0, 'USD/JPY': 0 },
  newsStatus: 'DATA UNAVAILABLE' as const, maxFxAgeSeconds: 180, strategyVersion: 'ARS-MSS-FVG v2.0',
}

export function calculatePositionSize(symbol: Symbol, equity: number, entry: number, stopLoss: number, riskPercent = 1, quoteToDkk: number | null = null) {
  const riskDkk = equity * (riskPercent / 100)
  const stopDistance = Math.abs(entry - stopLoss)
  if (![equity, entry, stopLoss, riskPercent].every(Number.isFinite) || !Number.isFinite(quoteToDkk) || quoteToDkk === null || quoteToDkk <= 0 || stopDistance <= 0 || riskDkk <= 0) return { riskDkk, nativeRisk: 0, positionSize: 0, available: false }
  const unitStep = symbol === 'XAU/USD' ? 0.01 : 1
  const rawSize = riskDkk / (stopDistance * quoteToDkk)
  const positionSize = Math.floor(rawSize / unitStep) * unitStep
  return { riskDkk, nativeRisk: positionSize * stopDistance, positionSize, available: positionSize > 0 && positionSize * stopDistance * quoteToDkk <= riskDkk + 1e-9 }
}

export function canOpenTrade(account: AccountState, plannedRr: number | null, newsBlocked = false) {
  return Boolean(plannedRr && plannedRr >= 2 && account.openTrades.length < 2 && !newsBlocked)
}

export const emptyAccount = (): AccountState => ({ balance: INITIAL_BALANCE, equity: INITIAL_BALANCE, dailyPnl: 0, openTrades: [], completedTrades: [], stats: { completedTrades: 0, wins: 0, losses: 0, winRate: null, netPnl: 0, averageWin: null, averageLoss: null, averageR: null, profitFactor: null, maxDrawdown: 0, currentLosingStreak: 0, largestLosingStreak: 0, stage: 'INSUFFICIENT DATA' } })

export const isValidTrade = (value: unknown): value is Trade => {
  if (!value || typeof value !== 'object') return false
  const trade = value as Partial<Trade>
  return typeof trade.id === 'string' && typeof trade.symbol === 'string' && typeof trade.entryPrice === 'number' && typeof trade.stopLoss === 'number'
}
