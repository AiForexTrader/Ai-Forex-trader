import { calculatePositionSize, DEFAULT_SETTINGS } from './paperTrading'
import type { FxRateSnapshot, Side, StrategySnapshot, Symbol, Trade } from './types'

export function createPaperTrade(input: { symbol: Symbol; side: Side; snapshot: StrategySnapshot; entryPrice: number; stopLoss: number; takeProfit: number; equity: number; setupTimestamp?: string; setupId?: string; entryCandleTimestamp?: string; conversion?: FxRateSnapshot }): Trade {
  const { snapshot } = input
  if (!snapshot.fvg || snapshot.plannedRr === null || snapshot.plannedRr < 2 || snapshot.asianHigh === null || snapshot.asianLow === null) throw new Error('A trade requires a confirmed MSS, valid FVG, Asian range, and minimum 1:2 R:R.')
  if (!input.conversion || input.conversion.rate === null || input.conversion.rate <= 0 || input.conversion.status === 'ERROR' || input.conversion.status === 'NOT_CONNECTED') throw new Error('POSITION SIZE UNAVAILABLE')
  const { riskDkk, nativeRisk, positionSize, available } = calculatePositionSize(input.symbol, input.equity, input.entryPrice, input.stopLoss, DEFAULT_SETTINGS.riskPercent, input.conversion.rate)
  if (!available) throw new Error('POSITION SIZE UNAVAILABLE')
  const setupTimestamp = input.setupTimestamp ?? new Date().toISOString()
  return {
    id: `paper-${Date.now()}`,
    symbol: input.symbol,
    side: input.side,
    setupTimestamp,
    entryTimestamp: new Date().toISOString(),
    session: snapshot.session,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    positionSize,
    riskDkk,
    plannedRr: snapshot.plannedRr,
    liquiditySweepDirection: input.side === 'BUY' ? 'LOW' : 'HIGH',
    asianHigh: snapshot.asianHigh,
    asianLow: snapshot.asianLow,
    mssConfirmed: snapshot.mss === 'CONFIRMED',
    fvgBounds: { lower: snapshot.fvg.lower, upper: snapshot.fvg.upper },
    fvgMidpoint: snapshot.fvg.midpoint,
    setupScore: snapshot.setupScore ?? 0,
    exitPrice: null,
    exitReason: null,
    pnlDkk: null,
    pnlR: null,
    winning: null,
    strategyVersion: DEFAULT_SETTINGS.strategyVersion,
    setupId: input.setupId ?? `legacy-${input.symbol}-${setupTimestamp}`,
    entryCandleTimestamp: input.entryCandleTimestamp ?? setupTimestamp,
    exitTimestamp: null,
    grossPnlDkk: null,
    estimatedCostsDkk: 0,
    netPnlDkk: null,
    simulated: true,
    positionUnit: input.symbol === 'XAU/USD' ? 'OUNCES' : 'USD_UNITS',
    nativeCurrency: input.symbol === 'XAU/USD' ? 'USD' : 'JPY',
    plannedRiskNative: nativeRisk,
    entryConversion: input.conversion,
    exitConversion: null,
    nativePnl: null,
  }
}
