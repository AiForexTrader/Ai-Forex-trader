import type { Candle, Fvg, Side, StrategySnapshot, Symbol } from './types'

export const STRATEGY_VERSION = 'ARS-MSS-FVG v1.0'

export function detectFvg(candles: Candle[], direction: Side): Fvg | null {
  if (candles.length < 3) return null
  const [first, , third] = candles.slice(-3)
  const isBullish = direction === 'BUY' && third.low > first.high
  const isBearish = direction === 'SELL' && third.high < first.low
  if (!isBullish && !isBearish) return null
  const lower = isBullish ? first.high : third.high
  const upper = isBullish ? third.low : first.low
  return { lower, upper, midpoint: (lower + upper) / 2, direction, formedAt: third.timestamp }
}

export function evaluateSetup(input: {
  symbol: Symbol
  session: StrategySnapshot['session']
  asianHigh: number | null
  asianLow: number | null
  candles5m: Candle[]
  candles15m: Candle[]
}): StrategySnapshot {
  const { asianHigh, asianLow, candles5m } = input
  if (asianHigh === null || asianLow === null || candles5m.length < 3) return { ...emptySnapshot(input), asianHigh, asianLow, decision: 'WATCHING', journal: `${input.symbol} is waiting for connected market data and a complete Asian range.` }
  const latest = candles5m.at(-1)!
  const sweptHigh = latest.high > asianHigh && latest.close < asianHigh
  const sweptLow = latest.low < asianLow && latest.close > asianLow
  const direction: Side = sweptLow ? 'BUY' : 'SELL'
  const swept = sweptHigh || sweptLow
  const mssConfirmed = swept && hasConfirmedMss(candles5m, direction)
  const fvg = swept ? detectFvg(candles5m, direction) : null
  if (!swept) return { ...emptySnapshot(input), asianHigh, asianLow, decision: 'WATCHING', journal: `${input.symbol} is inside the Asian range. No confirmed liquidity sweep.` }
  if (!mssConfirmed) return { ...emptySnapshot(input), asianHigh, asianLow, liquiditySweep: sweptHigh ? 'HIGH SWEPT' : 'LOW SWEPT', decision: 'WAITING FOR MSS', journal: `${input.symbol} swept the ${sweptHigh ? 'Asian high' : 'Asian low'}, but price has not confirmed a post-sweep structure shift.` }
  if (!fvg) return { ...emptySnapshot(input), asianHigh, asianLow, liquiditySweep: sweptHigh ? 'HIGH SWEPT' : 'LOW SWEPT', mss: 'CONFIRMED', decision: 'WAITING FOR FVG', journal: `${input.symbol} confirmed MSS after the sweep, but no valid displacement FVG is present.` }
  const plannedRr = 2
  const inRetracement = latest.close >= fvg.lower && latest.close <= fvg.upper
  return { ...emptySnapshot(input), asianHigh, asianLow, liquiditySweep: 'CONFIRMED', mss: 'CONFIRMED', fvg, setupScore: calculateSetupScore(input.candles5m, input.candles15m, inRetracement), plannedRr, decision: inRetracement ? (direction === 'BUY' ? 'PAPER BUY' : 'PAPER SELL') : 'WAIT FOR RETRACEMENT', journal: `${input.symbol} completed a ${sweptLow ? 'downside' : 'upside'} liquidity sweep and MSS. ${inRetracement ? 'Price is inside the FVG retracement zone; paper-trade eligibility still requires risk checks.' : 'Waiting for a retracement into the FVG midpoint.'}` }
}

function hasConfirmedMss(candles: Candle[], direction: Side): boolean {
  if (candles.length < 5) return false
  const latest = candles.at(-1)!
  const structureWindow = candles.slice(-5, -1)
  return direction === 'BUY'
    ? latest.close > Math.max(...structureWindow.map(candle => candle.high))
    : latest.close < Math.min(...structureWindow.map(candle => candle.low))
}

function calculateSetupScore(candles5m: Candle[], candles15m: Candle[], inRetracement: boolean): number {
  const latest = candles5m.at(-1)!
  const previous = candles5m.at(-2)!
  const displacement = Math.abs(latest.close - latest.open) > Math.abs(previous.close - previous.open)
  return Math.min(100, 40 + (displacement ? 20 : 0) + (candles15m.length >= 3 ? 20 : 0) + (inRetracement ? 20 : 0))
}

const emptySnapshot = (input: Pick<StrategySnapshot, 'symbol' | 'session'>): StrategySnapshot => ({ ...input, asianHigh: null, asianLow: null, decision: 'NO SETUP', setupScore: null, liquiditySweep: 'WAITING', mss: '—', fvg: null, plannedRr: null, journal: '', state: 'WATCHING', rejection: '—', retracement: '—', riskDkk: null, setupId: null })
