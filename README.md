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

Built and unit-tested, NOT connected to the app (so the app cannot place or change orders):
- The MT5 trading layer in the bridge and the order engine / risk gate in `packages/core` (`docs/ORDERS.md`).
  Missing: main-process service, Positions tab, confirm dialogs, "Place this order", trading settings, Stop-AI kill-switch hookup.
- The `propose_order_action` AI tool exists but answers "unavailable".

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
