# Orders: status and design (INCOMPLETE, DEMO ONLY)

## What exists and is tested (stand-in MT5 only)
- `bridge/aurum_bridge/trading.py`: guarded order endpoints. Disabled unless the bridge is started with `AURUM_TRADING=1`;
  non-demo accounts refused unless `AURUM_ALLOW_LIVE=1` too (account re-checked on every request). Loopback + token +
  Host-header check. Endpoints: `POST /trade/{open_market,open_pending,modify_sltp,close_position,partial_close,cancel_pending}`,
  `GET /positions /orders /deals /trade/status /trade/find?commandId=`.
- Contract: any non-200 answer means `order_send` was NOT called. A 200 carries `status` done | partial | rejected | unknown.
  `unknown` (None result, exception, timeout, retcode 10012/10031) is never retried; caller must reconcile via `/trade/find`.
- Magic `1096041045`; comment `AU:` + 24 hex of sha256(commandId) (27 chars, MT5 limit 31). A pre-send duplicate guard
  looks the tag up in positions/orders/history so a restarted bridge cannot resend a command.
- order_check before order_send; filling mode from `symbol_info().filling_mode` (retried only on INVALID_FILL);
  volume min/max/step, stops level, freeze level, symbol trade mode, Algo Trading / account trade_allowed checks.
- Full retcode table with clear messages. SLTP requests always send both SL and TP (omitting one would clear it).
- `packages/core/src/orders.ts`: `sizeOrder`, `partialCloseVolume` (step-safe, never >= position, valid remainder),
  `riskAtSl`, `slMoveAllowedAfterLimit` (manage_only: SL may not be widened/removed after the daily limit). Property-style tests.

## NOT built (do not enable trading in the app yet)
OrderCommand Zod pipeline with commandId registry/TTL, RiskGate, reconciliation loop, external-change sync,
SQLite immutable activity log, IPC, Positions panel and confirm dialogs, `propose_order_action` AI tool, kill-switch wiring,
`trading` settings flag. The main process does NOT start the bridge with `AURUM_TRADING`, so the app cannot trade.

## Planned reconciliation rules
Open: tagged deal/position/order => confirmed. Modify: position SL/TP equal requested => confirmed. Close/partial: tagged OUT
deal => confirmed. No trace must be seen on two checks a few seconds apart before `rejected`; ambiguous cases stay
`unknown_reconcile` (new orders blocked) until the owner resolves them.

## NOT verified (no MT5 in this sandbox)
Everything against a real terminal: filling modes on Exness, retcodes, history-window/server-time behaviour, comment
preservation on close deals, hedging vs netting. Run a DEMO-only manual test (open, SL modify, partial close, close,
pending place/cancel, kill the bridge mid-order) before any further work.
