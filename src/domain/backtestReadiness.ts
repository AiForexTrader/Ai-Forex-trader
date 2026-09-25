import type { HistoricalDataResponse, Symbol } from './types'

export type HistoricalDatasetKey = Symbol | 'USD/DKK'

export function requiredHistoricalDatasets(symbols: Symbol[]): HistoricalDatasetKey[] {
  return [...new Set([...symbols, 'USD/DKK' as const])]
}

export function datasetIsReady(dataset: HistoricalDataResponse | undefined): boolean {
  return Boolean(dataset && dataset.status === 'COMPLETE' && dataset.complete && (dataset.missingRanges?.length ?? 0) === 0 && (dataset.coveragePercent ?? 0) >= 99)
}

export function backtestReadiness(symbols: Symbol[], datasets: Partial<Record<HistoricalDatasetKey, HistoricalDataResponse>>): { ready: boolean; required: HistoricalDatasetKey[]; missing: HistoricalDatasetKey[] } {
  const required = requiredHistoricalDatasets(symbols)
  const missing = required.filter(key => !datasetIsReady(datasets[key]))
  return { ready: missing.length === 0, required, missing }
}
