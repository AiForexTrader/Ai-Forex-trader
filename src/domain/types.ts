export type Symbol = 'XAU/USD' | 'USD/JPY'
export type Side = 'BUY' | 'SELL'
export type Session = 'ASIA' | 'LONDON' | 'NEW YORK' | 'LONDON / NY OVERLAP' | 'OFF HOURS'
export type Decision = 'NO SETUP' | 'WATCHING' | 'LIQUIDITY SWEPT' | 'WAITING FOR REJECTION' | 'WAITING FOR MSS' | 'WAITING FOR FVG' | 'WAIT FOR RETRACEMENT' | 'PAPER BUY' | 'PAPER SELL' | 'TRADE ACTIVE' | 'TRADE CLOSED'
export type NewsStatus = 'NORMAL' | 'HIGH IMPACT NEWS SOON' | 'NEWS BLOCK ACTIVE' | 'DATA UNAVAILABLE'
export type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_PAPER_CLOSE' | 'SETUP_INVALIDATED_BEFORE_ENTRY' | 'AMBIGUOUS_INTRABAR' | 'INVALID_DATA'
export type ValidationStage = 'INSUFFICIENT DATA' | 'COLLECTING DATA' | 'RESEARCHING' | 'PROMISING' | 'VALIDATED' | 'REJECTED'
export type StrategyStateName = 'WAITING_FOR_ASIAN_RANGE' | 'WATCHING' | 'SWEEP_DETECTED' | 'WAITING_FOR_REJECTION' | 'WAITING_FOR_MSS' | 'WAITING_FOR_FVG' | 'WAITING_FOR_RETRACEMENT' | 'ENTRY_READY' | 'TRADE_ACTIVE' | 'COOLDOWN' | 'DATA_UNAVAILABLE'
export type FxRateStatus = 'LIVE' | 'STALE' | 'ERROR' | 'NOT_CONNECTED'
export type Currency = 'USD' | 'JPY' | 'DKK'
export type DatasetSegment = 'TRAINING' | 'VALIDATION' | 'OUT_OF_SAMPLE'
export type BacktestStatus = 'COMPLETE' | 'PARTIAL_DATA' | 'RATE_LIMITED' | 'ERROR'
export type HistoricalCollectionStatus = 'READY' | 'CHECKING_CACHE' | 'DOWNLOADING' | 'PARTIAL_DATA' | 'RATE_LIMITED' | 'NO_PROGRESS' | 'MARKET_CLOSED_RANGE' | 'COMPLETE' | 'ERROR'
export type ResearchValidationStatus = 'INSUFFICIENT_DATA' | 'COLLECTING_DATA' | 'RESEARCHING' | 'PROMISING' | 'VALIDATED' | 'REJECTED'

export interface Candle {
  symbol: Symbol
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  interval: '5min' | '15min'
  source: 'TWELVE_DATA'
  closed: boolean
}

export type MarketDataStatus = 'LIVE' | 'STALE' | 'ERROR' | 'NOT CONNECTED'

export interface MarketDataResponse {
  symbol: Symbol
  interval: Candle['interval']
  provider: 'Twelve Data'
  status: MarketDataStatus
  candles: Candle[]
  lastSuccessfulUpdate: string | null
  dataAgeSeconds: number | null
  diagnostic?: 'PROVIDER_CONNECTED' | 'PROVIDER_ERROR' | 'RATE_LIMITED' | 'INVALID_RESPONSE' | 'STALE_CACHE' | 'NOT_CONNECTED'
  error?: string
}

export interface FxRateSnapshot {
  baseCurrency: Currency
  quoteCurrency: 'DKK'
  rate: number | null
  timestamp: string | null
  source: string
  status: FxRateStatus
  ageSeconds: number | null
  diagnostic?: 'DIRECT' | 'DERIVED' | 'PROVIDER_ERROR' | 'RATE_LIMITED' | 'STALE_CACHE' | 'NOT_CONNECTED'
  error?: string
}

export interface FxRatesResponse {
  provider: 'Twelve Data'
  usdDkk: FxRateSnapshot
  jpyDkk: FxRateSnapshot
  fetchedAt: string
}

export interface HistoricalCandle {
  symbol: string
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  interval: '5min' | '15min'
  source: 'TWELVE_DATA'
  closed: true
}

export interface HistoricalDataResponse {
  symbol: string
  interval: '5min' | '15min'
  provider: 'Twelve Data'
  status: HistoricalCollectionStatus
  candles: HistoricalCandle[]
  requestedStart: string
  requestedEnd: string
  actualStart: string | null
  actualEnd: string | null
  missingIntervals: number
  complete: boolean
  missingRanges?: Array<{ start: string; end: string }>
  cachedCandles?: number
  requiredCandles?: number
  coveragePercent?: number
  nextAttemptAt?: string
  lastSuccessfulRequest?: string | null
  diagnostic?: string
  lastCollection?: HistoricalBatchDiagnostics
}

export interface HistoricalBatchDiagnostics {
  symbol: string
  interval: '5min' | '15min'
  requestedStart: string
  requestedEnd: string
  returnedOldestTimestamp: string | null
  returnedNewestTimestamp: string | null
  returnedCount: number
  newUniqueCandles: number
  duplicateCandles: number
  cacheBefore: number
  cacheAfter: number
  outcome: 'NEW_DATA' | 'DUPLICATE_ONLY' | 'MARKET_CLOSED_RANGE'
}

export interface Fvg {
  lower: number
  upper: number
  midpoint: number
  direction: Side
  formedAt: string
}

export interface AsianRange {
  sessionDate: string
  timeZone: string
  high: number
  low: number
  establishedAt: string
}

export interface LiquiditySweep {
  direction: 'HIGH' | 'LOW'
  timestamp: string
  extreme: number
  level: number
  distanceBeyondRange: number
  candleTimestamp: string
}

export interface RejectionConfirmation {
  direction: 'HIGH' | 'LOW'
  timestamp: string
  candleTimestamp: string
  reclaimLevel: number
}

export interface MssConfirmation {
  direction: Side
  structureLevel: number
  confirmationCandle: string
  confirmationTimestamp: string
  displacementSize: number
}

export interface StrategyState {
  symbol: Symbol
  state: StrategyStateName
  sessionDate: string | null
  asianRange: AsianRange | null
  sweep: LiquiditySweep | null
  rejection: RejectionConfirmation | null
  mss: MssConfirmation | null
  fvg: Fvg | null
  plannedRr: number | null
  riskDkk: number | null
  setupId: string | null
  lastProcessedCandle: string | null
  cooldownUntil: string | null
  lastJournalKey: string | null
  snapshot: StrategySnapshot | null
}

export interface StrategySnapshot {
  symbol: Symbol
  session: Session
  asianHigh: number | null
  asianLow: number | null
  decision: Decision
  setupScore: number | null
  liquiditySweep: 'WAITING' | 'HIGH SWEPT' | 'LOW SWEPT' | 'CONFIRMED'
  mss: '—' | 'CONFIRMED'
  fvg: Fvg | null
  plannedRr: number | null
  journal: string
  state: StrategyStateName
  rejection: 'WAITING' | 'CONFIRMED' | '—'
  retracement: 'WAITING' | 'REACHED' | '—'
  riskDkk: number | null
  setupId: string | null
}

export interface Trade {
  id: string
  symbol: Symbol
  side: Side
  setupTimestamp: string
  entryTimestamp: string
  session: Session
  entryPrice: number
  stopLoss: number
  takeProfit: number
  positionSize: number
  riskDkk: number
  plannedRr: number
  liquiditySweepDirection: 'HIGH' | 'LOW'
  asianHigh: number
  asianLow: number
  mssConfirmed: boolean
  fvgBounds: { lower: number; upper: number }
  fvgMidpoint: number
  setupScore: number
  exitPrice: number | null
  exitReason: ExitReason | null
  pnlDkk: number | null
  pnlR: number | null
  winning: boolean | null
  strategyVersion: string
  setupId: string
  entryCandleTimestamp: string
  exitTimestamp: string | null
  grossPnlDkk: number | null
  estimatedCostsDkk: number | null
  netPnlDkk: number | null
  simulated: true
  currentPrice?: number
  currentPnlDkk?: number
  currentR?: number
  positionUnit: 'OUNCES' | 'USD_UNITS'
  nativeCurrency: 'USD' | 'JPY'
  plannedRiskNative: number
  entryConversion: FxRateSnapshot
  exitConversion: FxRateSnapshot | null
  nativePnl: number | null
  timeframe?: '5min' | '15min'
  datasetSegment?: DatasetSegment
  conversionMethod?: 'HISTORICAL_FX' | 'FIXED_CONVERSION_ASSUMPTION' | 'UNAVAILABLE'
  settingsSnapshot?: StrategySettings
}

export interface StrategyStats {
  completedTrades: number
  wins: number
  losses: number
  winRate: number | null
  netPnl: number
  averageWin: number | null
  averageLoss: number | null
  averageR: number | null
  profitFactor: number | null
  maxDrawdown: number
  currentLosingStreak: number
  largestLosingStreak: number
  stage: ValidationStage
}

export interface AccountState {
  balance: number
  equity: number
  dailyPnl: number
  openTrades: Trade[]
  completedTrades: Trade[]
  stats: StrategyStats
}

export interface PersistedState {
  version: 2
  account: AccountState
  journal: string[]
  strategyStates: Record<Symbol, StrategyState>
  usedSetupIds: string[]
  settings: StrategySettings
}

export interface StrategySettings {
  riskPercent: number
  maxOpenTrades: number
  minimumRr: number
  fvgRetracementTarget: number
  fvgTolerance: number
  stopSafetyBuffer: number
  cooldownMinutes: number
  strategyInterval: '5min' | '15min'
  minimumFvgSize: Record<Symbol, number>
  reclaimBars: number
  quoteToDkk: { 'XAU/USD': number | null; 'USD/JPY': number | null }
  spread: Record<Symbol, number>
  slippage: Record<Symbol, number>
  newsStatus: NewsStatus
  maxFxAgeSeconds: number
  strategyVersion: string
}

export interface BacktestMetrics {
  completedTrades: number
  wins: number
  losses: number
  winRate: number | null
  grossPnl: number
  netPnl: number
  returnPercent: number
  averageWin: number | null
  averageLoss: number | null
  averageR: number | null
  medianR: number | null
  profitFactor: number | null
  expectancyPerTrade: number | null
  maxDrawdown: number
  maxDrawdownPercent: number
  currentLosingStreak: number
  largestLosingStreak: number
  largestWinningStreak: number
  averageHoldingMinutes: number | null
  ambiguousIntrabarCount: number
}

export interface BacktestSplit {
  segment: DatasetSegment
  start: string
  end: string
  metrics: BacktestMetrics
}

export interface BacktestRejections {
  NO_REJECTION: number
  NO_MSS: number
  NO_FVG: number
  NO_RETRACEMENT: number
  RR_BELOW_MINIMUM: number
  STALE_OR_MISSING_DATA: number
  POSITION_SIZE_INVALID: number
  SETUP_INVALIDATED: number
  SESSION_ENDED: number
}

export interface BacktestRun {
  runId: string
  strategyVersion: string
  symbols: Symbol[]
  timeframe: '5min' | '15min'
  requestedStart: string
  requestedEnd: string
  actualStart: string | null
  actualEnd: string | null
  candlesProcessed: number
  status: BacktestStatus
  provider: string
  conversionMethod: 'HISTORICAL_FX' | 'FIXED_CONVERSION_ASSUMPTION'
  costAssumption: 'ZERO_COST_BASELINE' | 'CONFIGURED_COST'
  settingsSnapshot: StrategySettings
  metrics: BacktestMetrics
  splits: BacktestSplit[]
  breakdowns: Record<string, BacktestMetrics>
  validationStatus: ResearchValidationStatus
  rejections: BacktestRejections
  trades: Trade[]
  createdAt: string
  diagnostic?: string
}
