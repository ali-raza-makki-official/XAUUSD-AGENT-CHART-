# Aurum

AI-controlled XAUUSD trading workspace for Windows. Real MT5 data only: no simulated or demo feed is built in.
Plan and design: `docs/PRODUCT_PROFILE.md`. Design tokens: `design/`.

## Status
Verified in a real Electron run (with a test-only MT5 stand-in; nothing was run against live MT5, brokers or AI providers):
- Chart with real MT5 feed only, DEMO/LIVE badge, 10 drawing tools with per-object settings, undo/redo, SQLite persistence.
- AI chat for Anthropic, OpenAI, Gemini and DeepSeek (keys stored encrypted), tool calling, analysis card, Stop AI, permissions.
- Indicators and 1/2/4-chart layouts (built and compiled; the UI was checked once after merge, not exhaustively).

Built and unit-tested, but NOT yet wired into the running app:
- Alerts engine, schedules and notifications (`packages/core`): no service runs it yet, no Alerts UI.
- WhatsApp gateway (`packages/core`, `apps/desktop/src/main/whatsapp.ts`): not started by the app, no settings UI. See `docs/WHATSAPP.md`.
- MT5 trading layer in the bridge (open, modify SL/TP, close, partial close) with a fake MT5 only. The app cannot place orders yet: no risk gate, no confirm UI. See `docs/ORDERS.md`.
- Connector hub (sessions, calendar, news, sentiment, related markets): UI and AI tools exist; calendar/news/sentiment need a provider URL from you. See `docs/CONNECTORS.md`.
- Windows installer and CI: configured, never run on Windows. See `docs/RELEASING.md`.

