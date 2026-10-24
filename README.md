# Aurum

AI-controlled XAUUSD trading workspace for Windows. Real MT5 data only: no simulated or demo feed is built in.
Plan and design: `docs/PRODUCT_PROFILE.md`. Design tokens: `design/`.

## Status
Checked in a real Electron run (against test-only stand-ins; nothing was run against live MT5, a real broker, a real AI provider or real WhatsApp):
- Chart on the real MT5 feed only, DEMO/LIVE badge, 10 drawing tools with per-object settings, undo/redo, SQLite persistence.
- AI chat for Anthropic, OpenAI, Gemini and DeepSeek (keys stored encrypted), tool calling, analysis card, Stop AI, permission switches.
- Alerts: the engine runs in the main process; UI, AI tools, one-fire and restart persistence were checked.

Wired and compiled, tests pass, but NOT checked in a running app:
- Indicators and 1/2/4-chart layouts (looked at once after the merge).
- WhatsApp gateway (`docs/WHATSAPP.md`): tested only against a mock server; the end-to-end Electron run did not complete.
- Connectors (`docs/CONNECTORS.md`): the sessions clock works locally; calendar, news and sentiment need a provider URL from you.

Orders (demo only, wired this session; checked in a real Electron run against the bridge test fake, NOT against real MT5):
- Settings > Trading enables order placement (Aurum refuses live accounts). Positions tab with SL to entry, set SL/TP, partial close 25/50%, close.
- "Place this order" on a Long/Short drawing: lot size from risk %, review, explicit Confirm. Every action goes through the risk gate and a confirm dialog; results show MT5's answer; unknown results are never resent.
- Stop AI sets the kill switch for AI-origin orders. The AI cannot place orders yet (`propose_order_action` is hidden).
- Run the manual test plan in `docs/ORDERS.md` on an Exness DEMO account before trusting any of it.

The Windows installer and CI are configured but have never run on Windows (`docs/RELEASING.md`).

## Run on Windows (development)
1. Install the MT5 terminal from your broker (Exness), log in to a **demo** account and add gold to Market Watch.
2. Install Node.js 20+ and Python 3.10+ (64-bit, same bitness as MT5), then `pip install MetaTrader5`.
3. `npm install` then `npm run dev`.
4. In the app: Settings > General, set the broker symbol (`GOLD`) or use "Find gold symbols in MT5".
5. Settings > AI: pick a provider, save the API key, "Load models", choose one, "Test connection".

The app attaches to the open MT5 terminal. No EA is needed and no MT5 password is stored.
Candle times follow the broker server clock, like the MT5 chart.

## Develop
- `npm test` runs core tests (Vitest), desktop tests and bridge tests (unittest).
- `npm run typecheck`
- The MT5 module exists only on Windows; tests use stand-ins. The app never fabricates market data.
- Release and installer: `docs/RELEASING.md`.
