# Aurum

AI-controlled XAUUSD trading workspace for Windows. Real MT5 data only: no simulated or demo feed is built in.
Plan and design: `docs/PRODUCT_PROFILE.md`. Design tokens: `design/`.

## What works now
- Electron desktop app with chart, MT5 connection status, bid/ask/spread, DEMO/LIVE badge.
- Drawing tools on the chart: horizontal/vertical line, ray, trendline, channel, zone, Fibonacci,
  long/short position (entry, SL, several TPs with pips and R), measure, text. Magnet snapping, undo/redo,
  lock, hide, duplicate, per-timeframe visibility, manual and AI layers, and a settings inspector for every object.
  Default style per tool is editable in Settings. Drawings are saved locally (SQLite) and restored on restart.
- Deterministic risk maths (lot size from risk %, SL distance and the broker contract spec).
- AI tool layer (`packages/core/src/aiTools.ts`): validated tools the AI will call, gated by permissions.
  The chat itself is **not connected to an LLM provider yet**.

## Not built yet
AI chat and provider adapters, alerts and schedules, WhatsApp gateway, news/calendar/sentiment connectors,
strategy builder, indicators, multi-chart layouts, order placement and trade management.

## Install on Windows (no Node or Python needed)
Download `Aurum-Setup-<version>.exe` from the GitHub Releases page (built by the Release workflow, see `docs/RELEASING.md`),
check it against `SHA256SUMS.txt`, and run it. It installs per user. You still need the MT5 terminal from your broker, logged in.
Builds are unsigned until a code-signing certificate is added, so SmartScreen may warn. The installer and auto-update path
have not yet been exercised on a real Windows machine. Local data: `%APPDATA%\Aurum` (daily backups of `aurum.db` in `backups\`).

## Run from source on Windows
1. Install the MT5 terminal from your broker (Exness), log in to a **demo** account, and add gold to Market Watch.
2. Install Node.js 20+ and Python 3.10+ (64-bit, same bitness as MT5).
3. `pip install MetaTrader5`
4. `npm install` then `npm run dev`
5. In the app: Settings, set the broker symbol (`GOLD`), or use "Find gold symbols in MT5".

The app attaches to the open MT5 terminal. No EA is needed and no MT5 password is stored.
Candle times follow the broker server clock, like the MT5 chart.

## Develop
- `npm test` runs core tests (Vitest) and bridge tests (unittest).
- `npm run typecheck`
- `npm run pack -w @aurum/desktop` makes an unpacked app; `npm run verify:fuses -w @aurum/desktop` checks its security fuses.
  Windows installer: `pip install MetaTrader5 pyinstaller`, `npm run bridge:exe`, `npm run dist:win` (see `docs/RELEASING.md`).
- The MT5 module only exists on Windows; tests use a stand-in for it. The app never fabricates market data.
