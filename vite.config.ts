import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { marketDataHandler } from './server/marketData.ts'
import { fxRatesHandler } from './server/fxRates.ts'
import { historicalDataHandler } from './server/historicalData.ts'
import { paperTradingHandler, startPaperTradingLoop } from './server/paperTrading.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (env.TWELVE_DATA_API_KEY) process.env.TWELVE_DATA_API_KEY = env.TWELVE_DATA_API_KEY
  return {
  plugins: [react(), {
    name: 'market-data-proxy',
    configureServer(server) {
      startPaperTradingLoop()
      server.middlewares.use('/api/market-data', (request, response) => { void marketDataHandler(request, response) })
      server.middlewares.use('/api/fx-rates', (request, response) => { void fxRatesHandler(request, response) })
      server.middlewares.use('/api/historical-data', (request, response) => { void historicalDataHandler(request, response) })
      server.middlewares.use('/api/paper-trading', (request, response) => { void paperTradingHandler(request, response) })
    },
  }],
  }
})
