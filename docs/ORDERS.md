> **Update:** orders now go through the AurumBridge EA (`docs/MQL5_BRIDGE.md`). The Python `trading.py` described below was removed; pending orders are not supported over the EA.

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

## Added in this iteration (packages/core only, tested with a fake broker)
- `orderCommand.ts`: Zod `OrderCommand` (open_market, open_pending, modify_sltp, close_position, partial_close, cancel_pending; `close_all` is a separate bulk command), actor manual|ai|whatsapp, `commandId`, expiry (120 s), human-readable PREVIEW.
- `riskGate.ts`: deterministic `evaluateGate` returning the exact failed rule (trading switch, demo/live, GOLD-only, actor/AI mode/permissions, kill switch, expiry, unresolved commands, missing SL, spread, slippage, volume, per-trade risk, open risk, max positions, daily loss with reset timezone, manage_only/freeze policies, SL widening after the limit).
- `orderEngine.ts`: prepare -> confirm (idempotent registry with TTL, in-flight de-dup, serialised sends) -> reconcile via find (never resends; no-trace needs two checks apart), owner `resolve`, restore after restart, bulk close.
- `orderTools.ts`: AI tool `propose_order_action` (PREVIEW only). It reports "unavailable" until the app supplies an `OrdersPort`, which it does NOT yet.
- `orderPlan.ts` (position drawing -> order, multi-TP = one position + planned partial closes) and `positionSync.ts` (external-change diff). Both unit-level only.
- Tests: `packages/core/test/orderEngine.test.ts` (duplicate never executes twice, unknown then retry reconciles without resend, SL not widened after limit, partial close step, AI suggest/kill switch/bulk permission, expiry, restore).

## INCOMPLETE: stays DISABLED (no order path is reachable from the app)
Not built, because the budget ran out: main-process `orders.ts` service, SQLite activity-log tables, IPC, Positions tab, Confirm dialog,
"Place this order" button, `OrdersSettings`/Trading tab, AI-permission rows, `OrdersPort` wiring in `useAiChat`, Stop-AI to kill-switch wiring,
`trading` settings flag, BridgeManager `AURUM_TRADING` env. The main process still does NOT start the bridge with `AURUM_TRADING`, so the app cannot trade.
No Electron/Playwright run and no manual test plan were done. Nothing ran against real MT5.
Live: `AURUM_ALLOW_LIVE` must never be set by the app; an expert would have to set it in the bridge environment by hand (not designed or confirmed here).

## Planned reconciliation rules
Open: tagged deal/position/order => confirmed. Modify: position SL/TP equal requested => confirmed. Close/partial: tagged OUT
deal => confirmed. No trace must be seen on two checks a few seconds apart before `rejected`; ambiguous cases stay
`unknown_reconcile` (new orders blocked) until the owner resolves them.

## NOT verified (no MT5 in this sandbox)
Everything against a real terminal: filling modes on Exness, retcodes, history-window/server-time behaviour, comment
preservation on close deals, hedging vs netting. Run a DEMO-only manual test (open, SL modify, partial close, close,
pending place/cancel, kill the bridge mid-order) before any further work.


## Wired in the app (this iteration)
Main process `orders.ts` (BrokerPort over the bridge, SQLite `order_records` and `order_activity`), IPC `orders:*`, Positions tab,
confirm dialog, "Place this order" in the Inspector, Settings > Trading, Stop AI -> kill switch.
Verified in real Electron against the bridge test fake (`bridge/tests/fake_mt5.py`): SL to entry, partial close 50%, full close, activity log,
records persisted. NOT verified: real MT5 (filling modes, retcodes, comments on close deals, hedging vs netting), AI-initiated orders (not wired),
pending orders UI, "external change" labels, the daily-limit policy with a real deal history.

## Manual test plan on an Exness DEMO account (Windows)
1. Open MT5, log in to the DEMO account, check the app shows `DEMO` in the top bar.
2. Settings > Trading: enable, set risk limits (start small), Save. The bridge restarts.
3. Draw a Long position, set risk % to 0.1, select it, Inspector > "Place this order". Read the review: lots, SL, risk. Confirm. Check MT5 shows the position with the SL.
4. Positions tab: "SL to entry", confirm; check MT5. Then 25% partial close, check volume in MT5. Then Close.
5. Press "Stop AI", try nothing from the AI: orders from the AI are not wired yet. Manual orders must still work.
6. Close MT5 while a confirm is pending, press Confirm: expect "Not sent" or "Result unknown" and NO second order after reconnecting.
7. Anything unexpected: stop, keep screenshots and the Feed log text, and report. To roll back: close positions in MT5 and untick Settings > Trading.
