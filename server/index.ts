import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { marketDataHandler } from './marketData'
import { fxRatesHandler } from './fxRates'
import { historicalDataHandler } from './historicalData'
import {
  paperTradingHandler,
  startPaperTradingLoop
} from './paperTrading'

const PORT = Number(process.env.PORT || 3000)
const DIST_DIR = join(process.cwd(), 'dist')

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
}

function serveFrontend(url: string, response: import('node:http').ServerResponse) {
  const pathname = decodeURIComponent(url.split('?')[0] || '/')
  const requested = pathname === '/' ? '/index.html' : pathname

  const relativePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = join(DIST_DIR, relativePath)

  if (
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  ) {
    filePath = join(DIST_DIR, 'index.html')
  }

  response.statusCode = 200
  response.setHeader(
    'Content-Type',
    contentTypes[extname(filePath).toLowerCase()] ??
      'application/octet-stream'
  )

  createReadStream(filePath).pipe(response)
}

const server = createServer((request, response) => {
  const url = request.url ?? '/'

  if (url.startsWith('/api/market-data')) {
    void marketDataHandler(request, response)
    return
  }

  if (url.startsWith('/api/fx-rates')) {
    void fxRatesHandler(request, response)
    return
  }

  if (url.startsWith('/api/historical-data')) {
    void historicalDataHandler(request, response)
    return
  }

  if (url.startsWith('/api/paper-trading')) {
    void paperTradingHandler(request, response)
    return
  }

  serveFrontend(url, response)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Forex Trader production server listening on port ${PORT}`)
})

startPaperTradingLoop()

function shutdown(signal: string) {
  console.log(`${signal} received — shutting down.`)

  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
