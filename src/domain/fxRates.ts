import type { FxRatesResponse } from './types'

export async function fetchFxRates(signal?: AbortSignal): Promise<FxRatesResponse> {
  const response = await fetch('/api/fx-rates', { signal })
  const payload = await response.json() as FxRatesResponse
  return payload
}

export function conversionForSymbol(rates: FxRatesResponse | null, symbol: 'XAU/USD' | 'USD/JPY') {
  return rates ? symbol === 'XAU/USD' ? rates.usdDkk : rates.jpyDkk : null
}
