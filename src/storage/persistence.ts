import { emptyAccount, DEFAULT_SETTINGS, isValidTrade } from '../domain/paperTrading'
import type { PersistedState, StrategyState, Symbol, Trade } from '../domain/types'

const STORAGE_KEY = 'ai-forex-trader:v2'
const LEGACY_STORAGE_KEY = 'ai-forex-trader:v1'
const symbols: Symbol[] = ['XAU/USD', 'USD/JPY']

export const emptyStrategyState = (symbol: Symbol): StrategyState => ({ symbol, state: 'WAITING_FOR_ASIAN_RANGE', sessionDate: null, asianRange: null, sweep: null, rejection: null, mss: null, fvg: null, plannedRr: null, riskDkk: null, setupId: null, lastProcessedCandle: null, cooldownUntil: null, lastJournalKey: null, snapshot: null })

export const defaultState = (): PersistedState => ({ version: 2, account: emptyAccount(), strategyStates: { 'XAU/USD': emptyStrategyState('XAU/USD'), 'USD/JPY': emptyStrategyState('USD/JPY') }, usedSetupIds: [], journal: [], settings: DEFAULT_SETTINGS })

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as Partial<PersistedState> & { version?: number; strategyStates?: Partial<Record<Symbol, StrategyState>>; usedSetupIds?: string[] }
    if (!parsed.account || !Array.isArray(parsed.account.openTrades) || !Array.isArray(parsed.account.completedTrades)) return defaultState()
    const openTrades = parsed.account.openTrades.filter(isValidTrade).map(upgradeTrade)
    const completedTrades = parsed.account.completedTrades.filter(isValidTrade).map(upgradeTrade)
    const base = defaultState()
    return {
      ...base,
      ...parsed,
      version: 2,
      account: { ...emptyAccount(), ...parsed.account, openTrades, completedTrades },
      strategyStates: Object.fromEntries(symbols.map(symbol => [symbol, parsed.version === 2 && parsed.strategyStates?.[symbol] ? { ...emptyStrategyState(symbol), ...parsed.strategyStates[symbol] } : emptyStrategyState(symbol)])) as PersistedState['strategyStates'],
      usedSetupIds: parsed.version === 2 && Array.isArray(parsed.usedSetupIds) ? parsed.usedSetupIds.filter(value => typeof value === 'string') : [],
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
    }
  } catch { return defaultState() }
}

export function saveState(state: PersistedState) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) }

function upgradeTrade(trade: Trade): Trade {
  const conversion = trade.entryConversion ?? { baseCurrency: trade.symbol === 'XAU/USD' ? 'USD' : 'JPY', quoteCurrency: 'DKK', rate: null, timestamp: null, source: 'Unavailable legacy conversion', status: 'NOT_CONNECTED', ageSeconds: null, diagnostic: 'NOT_CONNECTED' }
  return { ...trade, setupId: trade.setupId ?? `legacy-${trade.id}`, entryCandleTimestamp: trade.entryCandleTimestamp ?? trade.entryTimestamp, exitTimestamp: trade.exitTimestamp ?? (trade.exitPrice ? trade.entryTimestamp : null), grossPnlDkk: trade.grossPnlDkk ?? trade.pnlDkk, estimatedCostsDkk: trade.estimatedCostsDkk ?? 0, netPnlDkk: trade.netPnlDkk ?? trade.pnlDkk, simulated: true, positionUnit: trade.positionUnit ?? (trade.symbol === 'XAU/USD' ? 'OUNCES' : 'USD_UNITS'), nativeCurrency: trade.nativeCurrency ?? (trade.symbol === 'XAU/USD' ? 'USD' : 'JPY'), plannedRiskNative: trade.plannedRiskNative ?? 0, entryConversion: conversion, exitConversion: trade.exitConversion ?? null, nativePnl: trade.nativePnl ?? null }
}
