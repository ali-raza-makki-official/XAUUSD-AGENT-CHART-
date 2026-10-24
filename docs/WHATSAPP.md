# WhatsApp gateway

Messaging connector for the WhatsApp Agent Platform (developer manual v1, Aug 25 2026). Personal channel: the platform only lets an agent talk to its creator.

**Verification status.** Everything here was tested against a local mock HTTP server that mimics the manual's wire format (`packages/core/test/helpers/mockWhatsApp.ts`, test-only). The real WhatsApp service was NOT reachable from the build sandbox and has never been called. Expect to find differences on first real use.

## Layout
- `packages/core/src/whatsapp.ts`: Zod schemas, BigInt-safe updates parsing, offsets, error mapping and retry policy, rate limiter, text splitting, outbound queue, pure SHA-256.
- `packages/core/src/whatsappCommands.ts`: inbound pipeline (identity, de-dupe, expiry, permission levels, confirmation codes, slash commands), `RemoteActionHandler`, `RemoteAiHandler`, `Transcriber`, `WhatsAppStore`, in-memory store, stubs.
- `packages/core/src/outbound.ts`: `OutboundChannel { send(event) }` for the lead to bridge to the alerts `NotificationChannel`.
- `apps/desktop/src/main/whatsapp.ts`: live connector (poll loop, sends, media, receipts). No electron imports.
- `apps/desktop/src/main/whatsappStore.ts`: SQLite persistence (offset, link, seen ids, confirmations, history; `workspace_id` on every row).
- `apps/desktop/src/main/secrets.ts`: `setWhatsAppToken` etc. (own entry, provider keys unchanged; `AURUM_WHATSAPP_TOKEN` env for dev).

## Transport rules implemented
- One poller: `GET /updates?limit=50&timeout=20`, read timeout 35 s, limiter 15/min (we hold to 14). First ever poll omits `offset` (only new traffic). Later polls pass the stored `next_offset` unchanged; it is a string (64-bit safe) written only after the batch was classified and recorded. 204 keeps the offset. We never use `offset=0` automatically.
- 409/1752041: one retry after 10 s; a second 409 within 2 minutes stops polling (state `conflict`) so two clients do not fight. 429/500/network: exponential backoff, same offset. 400/100 or 401/190: stop (`auth_error`).
- Sends: 12/min (we hold to 11), one recipient lane at a time, parts in order, text split at 4096, captions 1024 with overflow as a follow-up text. Retry policy: 4xx never retried; 429 and 503/131016 backed off and re-sent (not sent); 500, reset or our read timeout (60 s) on a send is UNKNOWN: trade-related content is never re-sent, other content gets one retry (a duplicate is possible).
- Read receipt + typing indicator before replying (refreshed every 20 s during AI calls, best effort, skipped when the 12/min budget is tight).
- Inbound media: `GET /media/<id>`, download with token over https, size cap, SHA-256 checked against both the message digest (Base64) and the endpoint digest (hex), then best-effort delete. Voice notes need a configured `Transcriber`; otherwise the reply is "Voice notes are not supported yet." Voice can never confirm an action.

## Security model
- Only the linked creator `user:<id>` is obeyed. The id is an opaque conversation key. If it changes the sender is "not linked" until re-linked in the app.
- Linking: token entered in Settings; first message from the creator makes the app reply with a pairing message; the creator replies with a 6-digit code shown only in the app (5 min, 5 tries).
- Every message id is recorded once, persisted (survives restart). Messages older than `maxMessageAgeSec` (default 60 s), with unparseable or future timestamps, are never acted on. After downtime one summary is sent ("N messages arrived while Aurum was not running, I did not act on them").
- Permission levels: notify only, ask AI (default), chart control, trade actions. Trade proposals always need `CONFIRM <code>`; chart proposals do by default (`confirmChartActions`). `/pause` runs immediately (risk-reducing); `/resume` needs a code.
- Confirmation: 4-digit code, 2 min, single use, 3 wrong tries lock it, one pending at a time, bound by hash to the commandId, the exact action payload and preview, the code and the sender. "yes" or an emoji never confirm. Codes are masked in history. The AI only returns a `proposedAction`; it never sees the code and never executes from WhatsApp itself.
- The token lives in the OS-encrypted secrets file in the main process, only in the `Authorization` header, scrubbed from surfaced errors.
- Residual risk: the code travels over the same WhatsApp chat, so anyone holding the unlocked phone can confirm. If PC and phone clocks differ by more than the age limit, live messages look stale; keep the PC clock synced.

## PC off = no replies
The poller lives in the desktop app. If the PC or app is off, nothing answers. The platform keeps updates 30 days, so on restart the backlog is read, de-duplicated, and only summarised. Always-on needs a future cloud relay with execution kept on the local agent.

## Not done yet (see report)
Electron service/IPC wiring (`whatsappService.ts`, `shared.ts`/preload/main index hunks), `components/WhatsAppSettings.tsx`, the history view component, real-Electron screenshot verification, `/status` and `/price` real handlers (lead wires `RemoteActionHandler`).
