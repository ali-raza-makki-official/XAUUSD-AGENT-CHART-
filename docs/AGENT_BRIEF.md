# Aurum: brief for parallel workers

Read `README.md`, `docs/PRODUCT_PROFILE.md` (sections 7-22) first. This file is the working agreement.

## Product in one paragraph
Aurum is a Windows Electron desktop app: XAUUSD chart (lightweight-charts) fed ONLY by a real MT5 terminal via a local
Python bridge (`bridge/`), manual drawing tools, and an AI assistant that uses validated tools. Owner: a gold trader who
trades 50-100 pip stops on an Exness account (symbol `GOLD`), starting on DEMO. The product may later become SaaS.

## Non-negotiable rules
1. **No fake, simulated or sample market data in the product, ever.** If a source is unavailable, show a clear
   "not connected / no data" state. Test doubles are allowed in tests only, never shipped, never default.
2. **One command path.** Anything that changes state (drawings, alerts, orders) goes through a store/command with a unique
   `commandId` (idempotent), an `actor` (manual | ai | whatsapp | rule), validation (Zod), and an activity log entry.
   Manual UI and AI tools call the SAME function. Every new feature needs both a UI path and an AI tool (`packages/core/src/aiTools.ts` pattern).
3. **AI never gets uncontrolled access.** New AI tools declare the capability they need (`AiPermissions`), are hidden from the
   model when not permitted, are Zod-validated, and are covered by tests. Secrets and API keys never reach the renderer or the AI.
4. **Deterministic code does the maths** (lots, risk, indicators, alert evaluation). The LLM only reads results.
5. **Broker state is final authority** for anything about orders. "Executed" only after broker confirmation.
6. Safe defaults: AI order mode is `suggest`; nothing trades without explicit user action; live accounts need extra opt-in.
7. Professional UI: reuse `apps/desktop/src/renderer/src/components/ui.tsx` primitives (Button, IconButton, Switch, Segmented,
   Chip, Section, EmptyState), lucide-react icons, tokens in `styles.css` (:root vars). Dark theme, 4px grid, WCAG AA,
   visible focus, keyboard reachable, status never colour-only (icon + text). No new UI library.
8. Local-first: SQLite via `node:sqlite` in the main process (`apps/desktop/src/main/db.ts`), `workspace_id` on every row.
9. Security: renderer is sandboxed (contextIsolation, no node). New IPC goes through `src/shared.ts` + `src/preload/index.ts` +
   Zod-validated handlers in `src/main/index.ts`. Never log secrets.
10. Honesty: if something cannot be verified in this Linux sandbox (real MT5, real WhatsApp, real Windows installer), say so
    in your final report and in docs. Never claim it works against a live service you did not call.

## Repo map
- `packages/core` (TS, Vitest): types, Zod schemas, DrawingStore, risk maths, AI tools (`aiTools.ts`), LLM adapters (`providers.ts`, `llm.ts`), layout.
- `apps/desktop` (Electron + React 19 + Vite via electron-vite): `src/main` (bridge manager, db, ipc, secrets, llm), `src/preload`, `src/renderer/src`.
- `bridge/` (Python 3, stdlib HTTP, `MetaTrader5` pkg on Windows only): tests use a fake MT5 module.
- `design/tokens.json`, `design/logo.svg`.

## How to work
- You are in your own git worktree on your own branch. Run `npm install` at the repo root first.
- Checks you must run before finishing: `npm test`, `npm run typecheck`, `cd apps/desktop && npx electron-vite build`.
- If the feature has UI, verify it in real Electron: see "Run the real app headless" below, and look at a screenshot.
- Prefer NEW files for your feature. Edit shared files (`App.tsx`, `shared.ts`, `preload/index.ts`, `main/index.ts`,
  `styles.css`, `packages/core/src/index.ts`, `settings.ts`, `aiTools.ts`) only with small, additive changes, because other
  workers edit them in parallel and the lead merges. Do not reformat or reorganise existing code.
- Another worker (the lead) is concurrently adding: AI chat panel + provider settings. Do not build those.
- Commit on your branch with clear messages (end with the two trailer lines the lead's system gives; if unsure, omit).
  **Do not push. Do not create pull requests.** The lead merges your branch.
- Final report (keep it under 400 words): what you built, files touched in shared files (exact hunks the lead must watch),
  how you verified, what is NOT verified, any decisions the owner must make.

## Run the real app headless (Linux sandbox)
Xvfb + Playwright drive real Electron. Test-only MT5 stand-in lives outside the repo, create your own if needed:
`MetaTrader5.py` on `PYTHONPATH` exposing initialize/terminal_info/account_info/symbol_info/symbol_select/symbol_info_tick/copy_rates_from_pos/symbols_get/last_error + TIMEFRAME_* constants;
launch with `AURUM_PYTHON=python3`. Playwright: `require('/opt/node-tools/node_modules/playwright')._electron.launch({executablePath: <repo>/node_modules/electron/dist/electron, args:['--no-sandbox','--disable-gpu','--user-data-dir=<tmp>', '<repo>/apps/desktop']})`, run under `xvfb-run -a`.
Scratch files go in your scratchpad, not the repo.
