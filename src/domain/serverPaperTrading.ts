import type { PersistedState } from './types'

export interface ServerPaperTradingResponse {
  mode: 'PAPER_ONLY'
  running: boolean
  autoTrading: boolean
  intervalMs: number
  lastCycleAt: string | null
  lastError: string | null
  state: PersistedState
}

export async function fetchServerPaperState(
  signal?: AbortSignal
): Promise<ServerPaperTradingResponse> {
  const response = await fetch('/api/paper-trading', { signal })

  if (!response.ok) {
    throw new Error(`Paper trading server returned ${response.status}`)
  }

  return await response.json() as ServerPaperTradingResponse
}
