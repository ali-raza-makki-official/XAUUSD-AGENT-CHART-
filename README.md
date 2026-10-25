# Aurum

AI-controlled XAUUSD trading workspace for Windows. Real MT5 data only (through the AurumBridge EA): no simulated or demo feed is built in.
Plan and design: `docs/PRODUCT_PROFILE.md`. Design tokens: `design/`.

## Status
Checked in a real Electron run (against test-only stand-ins; nothing was run against live MT5, a real broker, a real AI provider or real WhatsApp):
- Chart on the real MT5 feed only, DEMO/LIVE badge, 10 drawing tools with per-object settings, undo/redo, SQLite persistence.
- AI chat for Anthropic, OpenAI, Gemini and DeepSeek (keys stored encrypted), tool calling, analysis card, Stop AI, permission switches.
- Alerts: the engine runs in the main process; UI, AI tools, one-fire and restart persistence were checked.

Wired and compiled, tests pass, but NOT checked in a running app:
- Indicators and 1/2/4-chart layouts (looked at once after the merge).
- WhatsApp gateway (`docs/WHATSAPP.md`): the full flow (pairing, commands, AI answers, 1/2 options, formatting, history, closing message) passed in a real Electron run against a mock WhatsApp server; never against the real platform.
- Connectors (`docs/CONNECTORS.md`): the sessions clock works locally; calendar, news and sentiment need a provider URL from you.

Orders (demo only, wired this session; checked in a real Electron run against the bridge test fake, NOT against real MT5):
- Settings > Trading enables order placement (Aurum refuses live accounts). Positions tab with SL to entry, set SL/TP, partial close 25/50%, close.
- "Place this order" on a Long/Short drawing: lot size from risk %, review, explicit Confirm. Every action goes through the risk gate and a confirm dialog; results show MT5's answer; unknown results are never resent.
- AI orders: only when Settings > AI > "Orders by the AI" is set to Confirm (needs trading enabled). The AI prepares a PREVIEW (`propose_order_action`); you press Confirm; the risk gate runs again. In Suggest mode the tool is not offered at all. Bulk close is never available to the AI. Stop AI sets the kill switch.
- Run the manual test plan in `docs/ORDERS.md` on an Exness DEMO account before trusting any of it.

Also added after the first checks (unit-tested, partly checked in Electron against stand-ins): all MT5 timeframes in a dropdown, resizable/hideable panels, zone validity (3 touches), `find_zones`, `watch_drawing` (approach + reached alerts), chart screenshots and voice/image/PDF input on WhatsApp with per-model capability routing, WhatsApp status notices, and a Journal with statistics from real closed MT5 deals. The EA must be recompiled for the new timeframes. Also: pre-trade checklist on the order review page, behaviour flags and rule-break tags in the Journal, "My view vs AI", a morning briefing and status messages on WhatsApp, and start with Windows. Plus the Trade Assistant (`docs/ASSISTANT.md`): plans you approve, ask-or-act at the zone, pip-based breakeven/trailing/partial, pips everywhere. Work through `docs/FIRST_RUN.md` on a demo account before relying on any of it.

MT5 connection: the **AurumBridge EA** (`bridge/mql5/AurumBridge.mq5`, `docs/MQL5_BRIDGE.md`) is the only bridge. The app side (WebSocket hub, orders, quotes) was checked against a protocol stand-in and the EA compiled and connected on the owner's PC; real broker retcodes, filling modes and pending orders are not verified. The old Python bridge was removed.

The Windows installer and CI are configured but have never run on Windows (`docs/RELEASING.md`).

## Run on Windows (development)
1. Install the MT5 terminal from your broker (Exness) and log in to a **demo** account.
2. Install Node.js 20+, then `npm install` and `npm run dev`.
3. In Aurum: Settings > General. It shows the **HubPort** and **AuthToken** (with a Copy button) and the EA setup steps.
4. In MT5: open MetaEditor, compile `bridge/mql5/AurumBridge.mq5`. Tools > Options > Expert Advisors: tick "Allow algorithmic trading" and add `http://127.0.0.1` to the allowed URLs.
5. Attach the EA to any chart and paste the HubPort and AuthToken into its inputs. Aurum shows "EA connected".
6. Set the broker symbol for gold in Settings > General (Exness: `XAUUSDm`). "Find gold symbols in MT5" lists the real names.
7. Settings > AI: pick a provider, save the API key, "Load models", choose one, "Test connection".

The EA only streams data until you set `EnableTrading=true` in its inputs (demo accounts only unless `AllowLive=true`). No MT5 password is stored.
Candle times follow the broker server clock, like the MT5 chart.

## Windows self-check
Run `powershell -ExecutionPolicy Bypass -File scripts\windows-smoke.ps1` from the repo folder. It changes nothing and prints PASS/FAIL/WARN for Node, installed MT5 terminals, whether MT5 is running at the same privilege level, port 8766, and `npm test`. The script was written but never run (no PowerShell in the build environment).

## Develop
- `npm test` runs core tests and desktop tests (Vitest).
- `npm run typecheck`
- Tests use stand-ins for the EA. The app never fabricates market data.
- Release and installer: `docs/RELEASING.md`.
