import type { BacktestRun } from '../domain/types'

const STORAGE_KEY = 'ai-forex-trader:backtests:v1'

export function loadBacktestRuns(): BacktestRun[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter(isBacktestRun).slice(0, 20) : []
  } catch { return [] }
}

export function saveBacktestRun(run: BacktestRun): void {
  const runs = loadBacktestRuns().filter(existing => existing.runId !== run.runId)
  localStorage.setItem(STORAGE_KEY, JSON.stringify([run, ...runs].slice(0, 20)))
}

function isBacktestRun(value: unknown): value is BacktestRun {
  if (!value || typeof value !== 'object') return false
  const run = value as Partial<BacktestRun>
  return typeof run.runId === 'string' && typeof run.strategyVersion === 'string' && Array.isArray(run.trades) && typeof run.metrics === 'object'
}
