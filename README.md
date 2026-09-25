# AI Forex Trader

Paper-trading research dashboard for an Asian Range -> Liquidity Sweep -> MSS -> FVG strategy.

## Status

- PAPER TRADING ONLY. No broker execution, wallet, credentials, or live orders.
- Market data provider: **Twelve Data**, accessed through the server-side `/api/market-data` proxy.
- Automatic paper engine: **ACTIVE WHILE THE APP IS OPEN**. It polls closed 5-minute or 15-minute candles every 60 seconds.
- Demo UI state is never included in strategy performance statistics.
- News filter architecture is present as `DATA UNAVAILABLE` until a real economic-calendar provider is connected.
- New paper entries require fresh server-side USD/DKK or JPY/DKK conversion data; unavailable or over-age rates block entries.
- Spread and slippage default to a clearly labelled zero-cost baseline; they are not claimed as live costs.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

The deterministic engine in `src/domain/paperEngine.ts` runs the state machine:
`WAITING_FOR_ASIAN_RANGE -> WATCHING -> WAITING_FOR_REJECTION -> WAITING_FOR_MSS -> WAITING_FOR_FVG -> WAITING_FOR_RETRACEMENT -> ENTRY_READY -> TRADE_ACTIVE -> COOLDOWN`.
It only evaluates closed candles, persists per-symbol state and consumed setup IDs, and uses a conservative `AMBIGUOUS_INTRABAR` exit when one candle touches both stop and target.

The V2 engine is intentionally not a 24/7 daemon. Automatic processing stops when the browser/dev server is stopped. A future worker or scheduled backend service should call the same deterministic engine with persisted state for unattended operation. Meaningful performance conclusions still require enough genuine completed trades, realistic conversion/cost data, and later historical/out-of-sample validation.