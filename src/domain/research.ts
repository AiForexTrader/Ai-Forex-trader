import type { StrategyStats, Trade } from './types'

export function calculateStrategyStats(completedTrades: Trade[]): StrategyStats {
  const closed = completedTrades.filter(trade => trade.pnlDkk !== null && trade.pnlR !== null)
  const wins = closed.filter(trade => trade.winning)
  const losses = closed.filter(trade => trade.winning === false)
  const netPnl = closed.reduce((sum, trade) => sum + (trade.pnlDkk ?? 0), 0)
  const grossWins = wins.reduce((sum, trade) => sum + Math.max(0, trade.pnlDkk ?? 0), 0)
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + Math.min(0, trade.pnlDkk ?? 0), 0))
  let currentLosingStreak = 0
  let largestLosingStreak = 0
  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  for (const trade of closed) {
    if (trade.winning === false) currentLosingStreak += 1
    else currentLosingStreak = 0
    largestLosingStreak = Math.max(largestLosingStreak, currentLosingStreak)
    equity += trade.pnlDkk ?? 0
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }
  return {
    completedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    netPnl,
    averageWin: wins.length ? grossWins / wins.length : null,
    averageLoss: losses.length ? -grossLosses / losses.length : null,
    averageR: closed.length ? closed.reduce((sum, trade) => sum + (trade.pnlR ?? 0), 0) / closed.length : null,
    profitFactor: grossLosses ? grossWins / grossLosses : null,
    maxDrawdown,
    currentLosingStreak,
    largestLosingStreak,
    stage: closed.length < 30 ? (closed.length ? 'COLLECTING DATA' : 'INSUFFICIENT DATA') : closed.length < 100 ? 'RESEARCHING' : 'PROMISING',
  }
}
