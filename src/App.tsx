import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Activity, BarChart3, BookOpen, ChevronRight, CircleHelp, Gauge, LayoutDashboard, Menu, Settings, ShieldCheck, SlidersHorizontal, TrendingUp } from 'lucide-react'
import { getActiveSession, formatSession } from './domain/session'
import { fetchMarketData, type MarketInterval } from './domain/marketData'
import { fetchFxRates } from './domain/fxRates'
import { clearHistoricalCache, fetchHistoricalCacheStats, fetchHistoricalData, type HistoricalCacheStats } from './domain/historicalData'
import { runBacktest } from './domain/backtest'
import { backtestReadiness, requiredHistoricalDatasets, type HistoricalDatasetKey } from './domain/backtestReadiness'
import { loadState } from './storage/persistence'
import { saveBacktestRun } from './storage/backtests'
import { fetchServerPaperState, type ServerPaperTradingResponse } from './domain/serverPaperTrading'
import type { BacktestRun, FxRatesResponse, HistoricalDataResponse, MarketDataResponse, PersistedState, Session, StrategySnapshot, Symbol } from './domain/types'

type Page = 'Overview' | 'Markets' | 'Open Trades' | 'Trade History' | 'Strategy Lab' | 'Journal' | 'Settings'

type MarketView = { snapshot: StrategySnapshot; data: MarketDataResponse; currentPrice: number | null }
const symbols: Symbol[] = ['XAU/USD', 'USD/JPY']
const emptyData = (symbol: Symbol, interval: MarketInterval): MarketDataResponse => ({ symbol, interval, provider: 'Twelve Data', status: 'NOT CONNECTED', candles: [], lastSuccessfulUpdate: null, dataAgeSeconds: null, diagnostic: 'NOT_CONNECTED' })
const emptySnapshot = (symbol: Symbol, session: Session): StrategySnapshot => ({ symbol, session, asianHigh: null, asianLow: null, decision: 'WATCHING', setupScore: null, liquiditySweep: 'WAITING', mss: '—', fvg: null, plannedRr: null, journal: `${symbol} is waiting for connected market data and a complete Asian range.`, state: 'DATA_UNAVAILABLE', rejection: '—', retracement: '—', riskDkk: null, setupId: null })
const navItems: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard }, { label: 'Markets', icon: BarChart3 }, { label: 'Open Trades', icon: TrendingUp }, { label: 'Trade History', icon: BookOpen }, { label: 'Strategy Lab', icon: SlidersHorizontal }, { label: 'Journal', icon: BookOpen }, { label: 'Settings', icon: Settings },
]

function App() {
  const [page, setPage] = useState<Page>('Overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [state, setState] = useState<PersistedState>(() => loadState())
  const [fxRates, setFxRates] = useState<FxRatesResponse | null>(null)
  const [paperServer, setPaperServer] = useState<ServerPaperTradingResponse | null>(null)
  const [interval, setInterval] = useState<MarketInterval>('5min')
  const [marketData, setMarketData] = useState<Record<Symbol, MarketView>>(() => Object.fromEntries(symbols.map(symbol => [symbol, { snapshot: emptySnapshot(symbol, getActiveSession()), data: emptyData(symbol, '5min'), currentPrice: null }])) as Record<Symbol, MarketView>)
  const session = getActiveSession()
  useEffect(() => {
    const controller = new AbortController()

    const refresh = async () => {
      try {
        const [results, currentFxRates, serverPaper] = await Promise.all([
          Promise.all(
            symbols.map(async symbol => ({
              symbol,
              data: await fetchMarketData(symbol, interval, controller.signal)
            }))
          ),
          fetchFxRates(controller.signal),
          fetchServerPaperState(controller.signal)
        ])

        setFxRates(currentFxRates)
        setPaperServer(serverPaper)
        setState(serverPaper.state)

        const views = Object.fromEntries(
          results.map(result => {
            const strategy = serverPaper.state.strategyStates[result.symbol]

            return [
              result.symbol,
              {
                snapshot:
                  strategy.snapshot ??
                  emptySnapshot(result.symbol, getActiveSession()),
                data: result.data,
                currentPrice:
                  result.data.candles.at(-1)?.close ?? null
              }
            ]
          })
        ) as Record<Symbol, MarketView>

        setMarketData(views)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return

        setFxRates(null)
        setPaperServer(null)
        setMarketData(current =>
          Object.fromEntries(
            symbols.map(symbol => [
              symbol,
              {
                ...current[symbol],
                data: {
                  ...current[symbol].data,
                  status: 'ERROR',
                  diagnostic: 'PROVIDER_ERROR',
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Provider request failed'
                }
              }
            ])
          ) as Record<Symbol, MarketView>
        )
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)

    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [interval])

  const go = (next: Page) => { setPage(next); setSidebarOpen(false) }
  const views = symbols.map(symbol => marketData[symbol])
  const connected = views.some(view => view.data.status === 'LIVE')
  const stale = !connected && views.some(view => view.data.status === 'STALE')

  return <div className="app-shell">
    <div style={{
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 1000,
      minWidth: 260,
      padding: '12px 14px',
      borderRadius: 12,
      background: 'rgba(15, 23, 42, 0.96)',
      border: '1px solid rgba(148, 163, 184, 0.25)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
      fontSize: 12,
      lineHeight: 1.55
    }}>
      <div style={{ fontWeight: 700, marginBottom: 5 }}>
        {paperServer?.autoTrading ? '🟢 AUTO PAPER TRADING' : '🔴 PAPER SERVER OFFLINE'}
      </div>

      <div>
        Status: {paperServer?.autoTrading ? 'RUNNING' : 'NOT RUNNING'}
      </div>

      <div>
        Mode: {paperServer?.mode ?? 'UNKNOWN'}
      </div>

      <div>
        Last cycle: {
          paperServer?.lastCycleAt
            ? new Date(paperServer.lastCycleAt).toLocaleTimeString()
            : '—'
        }
      </div>

      <div>
        XAU/USD candle: {
          state.strategyStates['XAU/USD']?.lastProcessedCandle
            ? new Date(
                state.strategyStates['XAU/USD'].lastProcessedCandle!
              ).toLocaleTimeString()
            : '—'
        }
      </div>

      <div>
        USD/JPY candle: {
          state.strategyStates['USD/JPY']?.lastProcessedCandle
            ? new Date(
                state.strategyStates['USD/JPY'].lastProcessedCandle!
              ).toLocaleTimeString()
            : '—'
        }
      </div>

      <div>
        Open trades: {state.account.openTrades.length}
      </div>

      <div>
        Completed: {state.account.completedTrades.length}
      </div>

      <div>
        Server error: {paperServer?.lastError ?? 'NONE'}
      </div>
    </div>
    <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><div className="brand-mark"><Activity size={18} /></div><div><strong>AI FOREX</strong><span>TRADER</span></div></div>
      <div className="mode-badge"><ShieldCheck size={13} /> PAPER TRADING</div>
      <nav>{navItems.map(({ label, icon: Icon }) => <button key={label} className={page === label ? 'nav-item active' : 'nav-item'} onClick={() => go(label)}><Icon size={17} /><span>{label}</span>{page === label && <ChevronRight size={14} className="nav-arrow" />}</button>)}</nav>
      <div className="sidebar-footer"><div className="secure-row"><span className="status-dot" /> Local paper environment</div><p>No broker connection<br />No real-money execution</p></div>
    </aside>
    {sidebarOpen && <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
    <main className="main-content">
      <header className="topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><div><p className="eyebrow">RESEARCH CONSOLE / {page.toUpperCase()}</p><h1>{page}</h1></div><div className="topbar-status"><div className="data-status"><span className={connected ? 'status-dot' : stale ? 'status-dot amber' : 'status-dot muted'} /><span>MARKET DATA<br /><b>{connected ? 'LIVE' : stale ? 'STALE' : 'ERROR'}</b></span></div><div className="session-status"><span className="status-dot amber" /><span>ACTIVE SESSION<br /><b>{formatSession(session)}</b></span></div><button className="help-button" aria-label="Help"><CircleHelp size={19} /></button></div></header>
      {page === 'Overview' ? <Overview state={state} marketData={marketData} session={session} interval={interval} onIntervalChange={setInterval} fxRates={fxRates} /> : <PageContent page={page} state={state} onStateChange={setState} onBack={() => go('Overview')} fxRates={fxRates} />}
    </main>
  </div>
}

function Overview({ state, marketData, session, interval, onIntervalChange, fxRates }: { state: PersistedState; marketData: Record<Symbol, MarketView>; session: Session; interval: MarketInterval; onIntervalChange: (interval: MarketInterval) => void; fxRates: FxRatesResponse | null }) {
  return <div className="content"><section className="notice-bar"><div><span className="notice-icon"><ShieldCheck size={16} /></span><span><strong>PAPER TRADING ONLY</strong><small>Strategy research environment. No live orders or broker execution.</small></span></div><span className="notice-link">News filter <b>DATA UNAVAILABLE</b></span></section>
    <section className="metrics-grid"><Metric label="Balance" value={formatDkk(state.account.balance)} detail="Starting capital · DKK" /><Metric label="Equity" value={formatDkk(state.account.equity)} detail="Live paper mark-to-market" /><Metric label="Today's P/L" value={formatDkk(state.account.dailyPnl)} detail="Verified paper trades only" neutral /><Metric label="Open trades" value={`${state.account.openTrades.length} / ${state.settings.maxOpenTrades}`} detail="Maximum simultaneous" /><Metric label="Risk exposure" value={formatDkk(state.account.openTrades.reduce((sum, trade) => sum + trade.riskDkk, 0))} detail={`${state.settings.riskPercent}% current-equity risk`} neutral /></section>
    <div className="section-heading"><div><p className="eyebrow">MARKET WATCHLIST</p><h2>Strategy conditions</h2></div><div className="timeframe"><button className={interval === '5min' ? 'selected' : ''} onClick={() => onIntervalChange('5min')}>5M</button><button className={interval === '15min' ? 'selected' : ''} onClick={() => onIntervalChange('15min')}>15M</button></div></div>
    <section className="market-grid">{Object.values(marketData).map(view => <MarketCard key={view.snapshot.symbol} view={view} session={session} />)}</section>
    <section className="lower-grid"><div className="panel positions-panel"><PanelHeading title="Open positions" action="View history" /><div className="table-wrap"><table><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Current</th><th>Stop loss</th><th>Take profit</th><th>R:R</th><th>Risk</th><th>P/L</th><th>Status</th></tr></thead><tbody>{state.account.openTrades.length ? state.account.openTrades.map(trade => <OpenTradeRow key={trade.id} trade={trade} />) : <tr><td colSpan={10}><EmptyState icon={<Gauge size={18} />} title="No open paper trades" text="Automatic paper entries require every strategy and risk condition to pass." /></td></tr>}</tbody></table></div></div><div className="panel research-panel"><PanelHeading title="Strategy performance" action="Strategy Lab" /><div className="research-target"><div><span className="eyebrow">RESEARCH TARGET</span><strong>≥65%</strong><small>Win rate target, not a guarantee</small></div><div className="target-line"><span /></div></div><div className="performance-grid"><Stat label="Verified win rate" value={state.account.stats.winRate === null ? 'N/A' : `${state.account.stats.winRate.toFixed(1)}%`} /><Stat label="Completed trades" value={String(state.account.stats.completedTrades)} /><Stat label="Profit factor" value={state.account.stats.profitFactor === null ? 'N/A' : state.account.stats.profitFactor.toFixed(2)} /><Stat label="Max drawdown" value={formatDkk(state.account.stats.maxDrawdown)} /></div><div className="stage-row"><span>VALIDATION STAGE</span><b>{state.account.stats.stage}</b></div></div></section>
    <section className="journal-section"><div className="section-heading compact"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Trade journal</h2></div><button className="text-button">Open journal <ChevronRight size={14} /></button></div><div className="journal-list">{Object.values(marketData).map((view, index) => <div className="journal-entry" key={view.snapshot.symbol}><span className="journal-time">{index === 0 ? 'NOW' : 'WAIT'}</span><div><strong>{view.snapshot.symbol}</strong><p>{view.snapshot.journal}</p></div><span className="decision-pill">{view.snapshot.decision}</span></div>)}</div><FxDiagnostic rates={fxRates} /></section>
    <footer className="footer-note"><span><ShieldCheck size={14} /> PAPER TRADING ONLY</span><span>Strategy version {state.settings.strategyVersion} · Demo UI data is excluded from performance statistics</span></footer>
  </div>
}

function MarketCard({ view, session }: { view: MarketView; session: Session }) { const { snapshot, data } = view; const statusText = data.status === 'LIVE' ? 'LIVE PROVIDER DATA' : data.status === 'STALE' ? 'STALE PROVIDER DATA' : data.status === 'ERROR' ? 'MARKET DATA ERROR' : 'WAITING FOR MARKET DATA'; return <article className="market-card"><div className="market-card-top"><div><h3>{snapshot.symbol}</h3><p>{snapshot.symbol === 'XAU/USD' ? 'Gold / US Dollar' : 'US Dollar / Japanese Yen'}</p></div><div className="score"><span>SETUP SCORE</span><strong>{snapshot.setupScore ?? 'N/A'}{snapshot.setupScore !== null && <small>/100</small>}</strong></div></div><div className="price-unavailable"><span className="dash">{view.currentPrice === null ? '—' : formatPrice(view.currentPrice, snapshot.symbol)}</span><span>{statusText}</span><small>{data.dataAgeSeconds === null ? data.error ?? 'Provider connection required' : `Twelve Data · updated ${data.dataAgeSeconds}s ago`}</small></div><div className="market-details"><DataPoint label="Session" value={formatSession(session)} accent /><DataPoint label="Asian high" value={formatPrice(snapshot.asianHigh, snapshot.symbol)} /><DataPoint label="Asian low" value={formatPrice(snapshot.asianLow, snapshot.symbol)} /><DataPoint label="Planned R:R" value={snapshot.plannedRr ? `${snapshot.plannedRr.toFixed(1)}R` : '—'} /><DataPoint label="Risk" value={snapshot.riskDkk === null ? '—' : formatDkk(snapshot.riskDkk)} /></div><div className="condition-list"><Condition label="Liquidity sweep" value={snapshot.liquiditySweep} /><Condition label="Rejection / reclaim" value={snapshot.rejection} /><Condition label="Market shift (MSS)" value={snapshot.mss} /><Condition label="Fair value gap" value={snapshot.fvg ? 'CONFIRMED' : '—'} /><Condition label="Retracement" value={snapshot.retracement} /></div><div className="card-footer"><span className="decision-text"><span className="status-dot amber" />{snapshot.decision}</span><span className="no-entry">{snapshot.state === 'TRADE_ACTIVE' ? 'SIMULATED' : 'NO ENTRY'}</span></div></article> }
function OpenTradeRow({ trade }: { trade: PersistedState['account']['openTrades'][number] }) { return <tr><td>{trade.symbol}</td><td className={trade.side === 'BUY' ? 'positive' : 'negative'}>{trade.side}</td><td>{formatPrice(trade.entryPrice, trade.symbol)}</td><td>{trade.currentPrice === undefined ? '—' : formatPrice(trade.currentPrice, trade.symbol)}</td><td>{formatPrice(trade.stopLoss, trade.symbol)}</td><td>{formatPrice(trade.takeProfit, trade.symbol)}</td><td>{trade.plannedRr.toFixed(2)}R</td><td>{formatDkk(trade.riskDkk)}</td><td>{trade.currentPnlDkk === undefined ? '—' : formatDkk(trade.currentPnlDkk)}</td><td>ACTIVE</td></tr> }
function DataPoint({ label, value, accent }: { label: string; value: string; accent?: boolean }) { return <div><span>{label}</span><strong className={accent ? 'accent' : ''}>{value}</strong></div> }
function Condition({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong className={value === 'CONFIRMED' ? 'positive' : value === 'WAITING' ? 'warning' : ''}>{value}</strong></div> }
function Metric({ label, value, detail, neutral = false }: { label: string; value: string; detail: string; neutral?: boolean }) { return <div className="metric"><span>{label}</span><strong className={neutral ? 'neutral-value' : ''}>{value}</strong><small>{detail}</small></div> }
function Stat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function PanelHeading({ title, action }: { title: string; action: string }) { return <div className="panel-heading"><h2>{title}</h2><button className="text-button">{action} <ChevronRight size={14} /></button></div> }
function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div> }
function PageContent({ page, state, onStateChange, onBack, fxRates }: { page: Page; state: PersistedState; onStateChange: Dispatch<SetStateAction<PersistedState>>; onBack: () => void; fxRates: FxRatesResponse | null }) {
  if (page === 'Open Trades') return <TradeTable title="Open trades" trades={state.account.openTrades} empty="No active simulated paper trades." onBack={onBack} />
  if (page === 'Trade History') return <TradeTable title="Trade history" trades={state.account.completedTrades} empty="No completed verified paper trades." history onBack={onBack} />
  if (page === 'Journal') return <div className="placeholder panel"><p className="eyebrow">DECISION LOG</p><h2>Journal</h2><div className="journal-list page-journal">{state.journal.length ? [...state.journal].reverse().map((entry, index) => <div className="journal-entry" key={`${entry}-${index}`}><span className="journal-time">LOG</span><p>{entry}</p></div>) : <p>No engine decisions recorded yet.</p>}</div></div>
  if (page === 'Strategy Lab') return <StrategyLabV3 state={state} />
  if (page === 'Settings') return <SettingsPage state={state} onStateChange={onStateChange} fxRates={fxRates} />
  return <div className="placeholder panel"><div className="placeholder-icon"><SlidersHorizontal size={20} /></div><p className="eyebrow">LIVE MARKETS</p><h2>{page}</h2><p>Select Overview for the active strategy pipeline and Twelve Data status.</p><button className="primary-button" onClick={onBack}>Return to overview</button></div>
}

function StrategyLabV3({ state }: { state: PersistedState }) {
  const [symbolsSelected, setSymbolsSelected] = useState<Symbol[]>(['XAU/USD', 'USD/JPY'])
  const [timeframe, setTimeframe] = useState<'5min' | '15min'>('5min')
  const [period, setPeriod] = useState<'1M' | '3M' | '6M' | '12M'>('1M')
  const [datasets, setDatasets] = useState<Record<string, HistoricalDataResponse>>({})
  const [cacheStats, setCacheStats] = useState<HistoricalCacheStats | null>(null)
  const [run, setRun] = useState<BacktestRun | null>(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('READY')
  const [error, setError] = useState<string | null>(null)

  // Use the newest candle shared by every required cached dataset.
  // This keeps historical research inside data that already exists.
  const cachedResearchEnd = () => {
    if (!cacheStats) return null

    const required = requiredHistoricalDatasets(symbolsSelected)
    const newest = required
      .map(symbol =>
        cacheStats.entries.find(
          entry => entry.symbol === symbol && entry.interval === timeframe
        )?.newest ?? null
      )

    if (newest.some(value => value === null)) return null

    return newest
      .filter((value): value is string => value !== null)
      .sort()
      .at(0) ?? null
  }

  const toggleSymbol = (symbol: Symbol) => setSymbolsSelected(current => current.includes(symbol) ? current.filter(value => value !== symbol) : [...current, symbol])
  const periodRange = () => {
    const intervalMinutes = timeframe === '5min' ? 5 : 15
    // Prefer the newest point shared by all required cached datasets.
    // Fall back to the latest fully closed candle when no cache exists yet.
    const cachedEnd = cachedResearchEnd()
    const end = cachedEnd ? new Date(cachedEnd) : new Date()
    end.setUTCSeconds(0, 0)
    end.setUTCMinutes(
      Math.floor(end.getUTCMinutes() / intervalMinutes) * intervalMinutes
    )
    end.setUTCMinutes(end.getUTCMinutes() - intervalMinutes)

    const start = new Date(end)
    start.setUTCMonth(
      start.getUTCMonth() -
        (period === '1M' ? 1 : period === '3M' ? 3 : period === '6M' ? 6 : 12)
    )

    return {
      start: start.toISOString(),
      end: end.toISOString()
    }
  }
  const refreshCache = async (collect: boolean) => {
    const { start, end } = periodRange()
    const keys = requiredHistoricalDatasets(symbolsSelected)
    const next: Record<string, HistoricalDataResponse> = {}
    setStatus(collect ? 'DOWNLOADING HISTORICAL DATA' : 'CHECKING_CACHE')
    for (const symbol of keys) {
      const result = await fetchHistoricalData(symbol, timeframe, start, end, undefined, collect)
      next[symbol] = result
      setDatasets(current => ({ ...current, [symbol]: result }))
      if (result.status === 'RATE_LIMITED') break
    }
    setCacheStats(await fetchHistoricalCacheStats())
    if (!collect) {
      const checkedReadiness = backtestReadiness(symbolsSelected, next)
      setStatus(checkedReadiness.ready ? 'READY' : 'PARTIAL_DATA')
    }
    return { next, start, end }
  }
  useEffect(() => {
    let cancelled = false

    const loadExistingCache = async () => {
      try {
        const { start, end } = periodRange()
        const keys = requiredHistoricalDatasets(symbolsSelected)
        const next: Record<string, HistoricalDataResponse> = {}

        for (const symbol of keys) {
          const result = await fetchHistoricalData(
            symbol,
            timeframe,
            start,
            end,
            undefined,
            false
          )
          if (cancelled) return
          next[symbol] = result
        }

        if (cancelled) return

        setDatasets(next)
        setCacheStats(await fetchHistoricalCacheStats())

        const checked = backtestReadiness(symbolsSelected, next)
        setStatus(checked.ready ? 'READY' : 'PARTIAL_DATA')
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Could not read historical cache')
          setStatus('ERROR')
        }
      }
    }

    void loadExistingCache()

    return () => {
      cancelled = true
    }
  }, [timeframe, period, symbolsSelected.join('|')])

  const runResearch = async () => {
    if (!symbolsSelected.length) return
    setRunning(true); setError(null)
    try {
      const data = datasets
      const readiness = backtestReadiness(symbolsSelected, data)
      if (!readiness.ready) {
        setStatus('PARTIAL_DATA')
        return
      }
      setStatus('REPLAYING CANDLES')
      const range = periodRange()
      const result = runBacktest({ symbols: symbolsSelected, timeframe, marketData: Object.fromEntries(symbolsSelected.map(symbol => [symbol, data[symbol]])), usdDkk: data['USD/DKK'].candles, jpyDkk: data['JPY/DKK']?.candles ?? [], usdJpy: data['USD/JPY']?.candles ?? [], requestedStart: range.start, requestedEnd: range.end, settings: structuredClone(state.settings) })
      setRun(result); saveBacktestRun(result); setStatus(result.status)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Historical collection failed'); setStatus('ERROR') } finally { setRunning(false) }
  }
  const clearCache = async () => { if (!window.confirm('Clear historical research cache only? Live paper trades will not be changed.')) return; await clearHistoricalCache(); setDatasets({}); setCacheStats(await fetchHistoricalCacheStats()); setRun(null); setStatus('READY') }
  const readiness = backtestReadiness(symbolsSelected, datasets)
  const actionLabel = readiness.ready ? 'RUN BACKTEST' : status === 'RATE_LIMITED' ? 'CONTINUE DOWNLOAD' : 'DOWNLOAD DATA'
  return <div className="placeholder panel wide-page"><div className="panel-heading"><div><p className="eyebrow">BASELINE RESEARCH</p><h2>Strategy Lab</h2></div><span className="decision-pill">{readiness.ready ? 'READY FOR BACKTEST' : status}</span></div><div className="backtest-controls"><label>Markets<div className="control-options">{(['XAU/USD', 'USD/JPY'] as Symbol[]).map(symbol => <label key={symbol}><input type="checkbox" checked={symbolsSelected.includes(symbol)} onChange={() => toggleSymbol(symbol)} />{symbol}</label>)}</div></label><label>Timeframe<select value={timeframe} onChange={event => setTimeframe(event.target.value as '5min' | '15min')}><option value="5min">5M</option><option value="15min">15M</option></select></label><label>Period<select value={period} onChange={event => setPeriod(event.target.value as typeof period)}><option>1M</option><option>3M</option><option>6M</option><option>12M</option></select></label><button
  className="primary-button"
  disabled={running || !symbolsSelected.length}
  onClick={() => {
    if (readiness.ready) {
      void runResearch()
    } else {
      setRunning(true)
      setError(null)
      void refreshCache(true)
        .then(({ next }) => {
          const checked = backtestReadiness(symbolsSelected, next)
          setStatus(
            checked.ready
              ? 'READY'
              : Object.values(next).some(value => value.status === 'RATE_LIMITED')
                ? 'RATE_LIMITED'
                : 'PARTIAL_DATA'
          )
        })
        .catch(caught => {
          setError(caught instanceof Error ? caught.message : 'Historical collection failed')
          setStatus('ERROR')
        })
        .finally(() => setRunning(false))
    }
  }}
>
  {running ? status : actionLabel}
</button></div><div className="historical-progress"><div className="panel-heading"><h2>Historical data</h2><button className="text-button" onClick={() => void refreshCache(false)}>Refresh cache status</button></div>{(['XAU/USD', 'USD/JPY', 'USD/DKK'] as HistoricalDatasetKey[]).map(symbol => <HistoricalProgress key={symbol} symbol={symbol} interval={timeframe} dataset={datasets[symbol]} required={readiness.required.includes(symbol)} />)}<div className="stage-row"><span>PROVIDER REQUESTS</span><b>{cacheStats ? `${cacheStats.budget.successful} successful · ${cacheStats.budget.requestsWithNewData} with new data · ${cacheStats.budget.requestsDuplicateOnly} duplicate-only · ${cacheStats.budget.rateLimited} rate limited` : 'No collection cycle yet'}</b></div>{cacheStats?.lastCollection && <p className="muted-copy">Last batch: +{cacheStats.lastCollection.newUniqueCandles} new · {cacheStats.lastCollection.duplicateCandles} duplicates{cacheStats.lastCollection.outcome === 'DUPLICATE_ONLY' ? ' · NO PROGRESS — provider returned already cached data' : ''}</p>}<button className="text-button" onClick={() => void clearCache()}>Clear historical cache</button></div>{error && <p className="muted-copy">{error}</p>}{run ? <BacktestResults run={run} /> : <p className="muted-copy">Historical data is persistent and separate from live paper trading. Partial or rate-limited datasets are never presented as full-period research.</p>}</div>
}

function HistoricalProgress({ symbol, interval, dataset, required }: { symbol: string; interval: '5min' | '15min'; dataset?: HistoricalDataResponse; required?: boolean }) { const coverage = dataset?.coveragePercent ?? 0; const ready = dataset?.complete && (dataset.missingRanges?.length ?? 0) === 0; return <div className="historical-row"><div><strong>{symbol} {interval === '5min' ? '5M' : '15M'}</strong><small>{dataset?.actualStart ? `${formatDate(dataset.actualStart)} to ${formatDate(dataset.actualEnd ?? dataset.actualStart)}` : 'No cached range for requested period'}</small></div><b>{dataset ? `${dataset.cachedCandles ?? dataset.candles.length} / ${dataset.requiredCandles ?? '—'} · ${coverage.toFixed(1)}%` : '—'}</b><span>{required === false ? 'NOT REQUIRED' : ready ? 'READY' : dataset?.status ?? 'READY'}</span></div> }

function StrategyLab({ state }: { state: PersistedState }) {
  const [symbolsSelected, setSymbolsSelected] = useState<Symbol[]>(['XAU/USD', 'USD/JPY'])
  const [timeframe, setTimeframe] = useState<'5min' | '15min'>('5min')
  const [period, setPeriod] = useState<'1M' | '3M' | '6M' | '12M'>('1M')
  const [run, setRun] = useState<BacktestRun | null>(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('READY')
  const toggleSymbol = (symbol: Symbol) => setSymbolsSelected(current => current.includes(symbol) ? current.filter(value => value !== symbol) : [...current, symbol])
  const runResearch = async () => {
    if (!symbolsSelected.length) return
    setRunning(true); setStatus('DOWNLOADING HISTORICAL DATA')
    const end = new Date()
    const start = new Date(end)
    const months = period === '1M' ? 1 : period === '3M' ? 3 : period === '6M' ? 6 : 12
    start.setUTCMonth(start.getUTCMonth() - months)
    const startIso = start.toISOString()
    const endIso = end.toISOString()
    try {
      const marketEntries = await Promise.all(symbolsSelected.map(async symbol => [symbol, await fetchHistoricalData(symbol, timeframe, startIso, endIso)] as const))
      const [usdDkk, jpyDkk, usdJpy] = await Promise.all([fetchHistoricalData('USD/DKK', timeframe, startIso, endIso), fetchHistoricalData('JPY/DKK', timeframe, startIso, endIso), fetchHistoricalData('USD/JPY', timeframe, startIso, endIso)])
      setStatus('REPLAYING CANDLES')
      const result = runBacktest({ symbols: symbolsSelected, timeframe, marketData: Object.fromEntries(marketEntries) as Record<Symbol, Awaited<ReturnType<typeof fetchHistoricalData>>>, usdDkk: usdDkk.candles, jpyDkk: jpyDkk.candles, usdJpy: usdJpy.candles, requestedStart: startIso, requestedEnd: endIso, settings: structuredClone(state.settings) })
      setRun(result); saveBacktestRun(result); setStatus(result.status)
    } catch (error) { setStatus(error instanceof Error ? error.message : 'BACKTEST ERROR') } finally { setRunning(false) }
  }
  return <div className="placeholder panel wide-page"><div className="panel-heading"><div><p className="eyebrow">BASELINE RESEARCH</p><h2>Strategy Lab</h2></div><span className="decision-pill">{status}</span></div><div className="backtest-controls"><label>Markets<div className="control-options">{(['XAU/USD', 'USD/JPY'] as Symbol[]).map(symbol => <label key={symbol}><input type="checkbox" checked={symbolsSelected.includes(symbol)} onChange={() => toggleSymbol(symbol)} />{symbol}</label>)}</div></label><label>Timeframe<select value={timeframe} onChange={event => setTimeframe(event.target.value as '5min' | '15min')}><option value="5min">5M</option><option value="15min">15M</option></select></label><label>Period<select value={period} onChange={event => setPeriod(event.target.value as typeof period)}><option>1M</option><option>3M</option><option>6M</option><option>12M</option></select></label><button className="primary-button" disabled={running || !symbolsSelected.length} onClick={() => void runResearch()}>{running ? status : 'Run backtest'}</button></div>{run ? <BacktestResults run={run} /> : <p className="muted-copy">Historical results are isolated from live paper balance, positions, setup IDs, and verified live statistics. The research target is ≥65%, not a guarantee.</p>}</div>
}

function BacktestResults({ run }: { run: BacktestRun }) { const metric = run.metrics; const sample = metric.completedTrades < 30 ? 'VERY SMALL SAMPLE' : metric.completedTrades < 100 ? 'LIMITED SAMPLE' : metric.completedTrades < 200 ? 'DEVELOPING SAMPLE' : 'MORE MEANINGFUL SAMPLE'; return <div className="backtest-results"><div className="stage-row"><span>BACKTEST RESULTS</span><b>{run.status} · {sample}</b></div><p className="muted-copy">Requested {formatDate(run.requestedStart)} to {formatDate(run.requestedEnd)}. Actual {run.actualStart ? formatDate(run.actualStart) : 'N/A'} to {run.actualEnd ? formatDate(run.actualEnd) : 'N/A'} · {run.candlesProcessed} candles · {run.provider} · {run.conversionMethod}</p><div className="performance-grid"><Stat label="Completed trades" value={String(metric.completedTrades)} /><Stat label="Net P/L" value={formatDkk(metric.netPnl)} /><Stat label="Win rate" value={metric.winRate === null ? 'N/A' : `${metric.winRate.toFixed(1)}%`} /><Stat label="Profit factor" value={metric.profitFactor === null ? 'N/A' : metric.profitFactor.toFixed(2)} /><Stat label="Expectancy" value={metric.expectancyPerTrade === null ? 'N/A' : formatDkk(metric.expectancyPerTrade)} /><Stat label="Max drawdown" value={formatDkk(metric.maxDrawdown)} /></div><div className="research-target"><div><span className="eyebrow">RESEARCH TARGET ≥65%</span><strong>{metric.winRate !== null && metric.winRate >= 65 ? 'TARGET NOT CONFIRMED' : 'TARGET NOT CONFIRMED'}</strong><small>Training, validation, and out-of-sample results must be considered separately.</small></div></div><div className="split-results">{run.splits.map(split => <div key={split.segment}><span>{split.segment}</span><b>{split.metrics.completedTrades} trades</b><small>{split.metrics.winRate === null ? 'N/A' : `${split.metrics.winRate.toFixed(1)}% win rate`} · {formatDkk(split.metrics.netPnl)} net</small></div>)}</div><div className="stage-row"><span>REJECTION DIAGNOSTICS</span><b>{Object.entries(run.rejections).map(([key, value]) => `${key}: ${value}`).join(' · ')}</b></div><div className="journal-list">{run.trades.map(trade => <div className="journal-entry" key={trade.id}><span className="journal-time">{trade.datasetSegment ?? 'TRAINING'}</span><div><strong>{trade.symbol} {trade.side}</strong><p>Entry {formatPrice(trade.entryPrice, trade.symbol)} · Exit {formatPrice(trade.exitPrice, trade.symbol)} · {trade.exitReason ?? 'OPEN'} · {trade.pnlR === null ? 'N/A' : `${trade.pnlR.toFixed(2)}R`}</p></div><span className="decision-pill">{trade.winning ? 'WIN' : trade.winning === false ? 'LOSS' : 'OPEN'}</span></div>)}</div></div> }

function TradeTable({ title, trades, empty, history = false, onBack }: { title: string; trades: PersistedState['account']['openTrades']; empty: string; history?: boolean; onBack: () => void }) { return <div className="placeholder panel wide-page"><div className="panel-heading"><div><p className="eyebrow">PAPER TRADING</p><h2>{title}</h2></div><button className="text-button" onClick={onBack}>Overview <ChevronRight size={14} /></button></div>{trades.length ? <div className="table-wrap"><table><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>{history ? 'Exit' : 'Current'}</th><th>SL</th><th>TP</th><th>Size</th><th>Risk</th><th>{history ? 'Net P/L' : 'P/L'}</th><th>{history ? 'Reason' : 'R'}</th><th>Status</th></tr></thead><tbody>{trades.map(trade => <tr key={trade.id}><td>{trade.symbol}</td><td className={trade.side === 'BUY' ? 'positive' : 'negative'}>{trade.side}</td><td>{formatPrice(trade.entryPrice, trade.symbol)}</td><td>{history ? formatPrice(trade.exitPrice, trade.symbol) : formatPrice(trade.currentPrice ?? null, trade.symbol)}</td><td>{formatPrice(trade.stopLoss, trade.symbol)}</td><td>{formatPrice(trade.takeProfit, trade.symbol)}</td><td>{trade.positionSize.toFixed(2)}</td><td>{formatDkk(trade.riskDkk)}</td><td>{formatDkk(history ? trade.netPnlDkk ?? 0 : trade.currentPnlDkk ?? 0)}</td><td>{history ? trade.exitReason ?? '—' : `${(trade.currentR ?? 0).toFixed(2)}R`}</td><td>{history ? (trade.winning ? 'WIN' : 'LOSS') : 'ACTIVE'}</td></tr>)}</tbody></table></div> : <EmptyState icon={<Gauge size={18} />} title={empty} text="No fabricated or demo trades are shown here." />}</div> }

function SettingsPage({ state, onStateChange, fxRates }: { state: PersistedState; onStateChange: Dispatch<SetStateAction<PersistedState>>; fxRates: FxRatesResponse | null }) {
  const update = <K extends keyof PersistedState['settings']>(key: K, value: PersistedState['settings'][K]) => onStateChange(current => ({ ...current, settings: { ...current.settings, [key]: value } }))
  return <div className="placeholder panel settings-page"><p className="eyebrow">ENGINE CONTROLS</p><h2>Settings</h2><p className="muted-copy">Changes affect future paper entries only. Existing positions retain their original risk, stop, target, and cost assumptions.</p><div className="settings-grid"><label>Risk per trade (%)<input type="number" min="0.1" max="5" step="0.1" value={state.settings.riskPercent} onChange={event => update('riskPercent', Number(event.target.value))} /></label><label>Maximum open trades<input type="number" min="1" max="2" step="1" value={state.settings.maxOpenTrades} onChange={event => update('maxOpenTrades', Number(event.target.value))} /></label><label>Minimum R:R<input type="number" min="2" step="0.1" value={state.settings.minimumRr} onChange={event => update('minimumRr', Number(event.target.value))} /></label><label>FVG tolerance<input type="number" min="0" max="1" step="0.05" value={state.settings.fvgTolerance} onChange={event => update('fvgTolerance', Number(event.target.value))} /></label><label>Stop safety buffer<input type="number" min="0" step="0.01" value={state.settings.stopSafetyBuffer} onChange={event => update('stopSafetyBuffer', Number(event.target.value))} /></label><label>Cooldown (minutes)<input type="number" min="0" step="5" value={state.settings.cooldownMinutes} onChange={event => update('cooldownMinutes', Number(event.target.value))} /></label></div><div className="stage-row"><span>EXECUTION MODE</span><b>PAPER ONLY · ZERO COST BASELINE</b></div><FxDiagnostic rates={fxRates} /><p className="muted-copy">Entries require live or acceptably fresh cached conversion data. Rates are never supplied by the browser.</p></div>
}
function FxDiagnostic({ rates }: { rates: FxRatesResponse | null }) { const rate = (value: FxRatesResponse['usdDkk']) => value.rate === null ? '—' : value.rate.toFixed(5); const details = (value: FxRatesResponse['usdDkk']) => `${value.status} · ${value.source} · ${value.ageSeconds === null ? '—' : `${value.ageSeconds}s ago`}`; return <div className="fx-diagnostic"><span className="eyebrow">CURRENCY CONVERSION</span><div><strong>USD/DKK</strong><b>{rates ? rate(rates.usdDkk) : '—'}</b><small>{rates ? details(rates.usdDkk) : 'NOT CONNECTED'}</small></div><div><strong>JPY/DKK</strong><b>{rates ? rate(rates.jpyDkk) : '—'}</b><small>{rates ? details(rates.jpyDkk) : 'NOT CONNECTED'}</small></div></div> }
const formatDkk = (value: number) => `${value.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DKK`
const formatPrice = (value: number | null, symbol: Symbol) => value === null ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: symbol === 'XAU/USD' ? 2 : 3, maximumFractionDigits: symbol === 'XAU/USD' ? 2 : 3 })
const formatDate = (value: string) => new Date(value).toLocaleDateString('en-GB', { timeZone: 'UTC' })

export default App
