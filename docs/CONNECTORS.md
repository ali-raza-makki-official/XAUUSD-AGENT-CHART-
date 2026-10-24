# Connectors (market context)

Contract: `packages/core/src/connectors.ts` (manifest, `testConnection()`, health, token-bucket rate limit honouring Retry-After,
TTL cache, stale flag, error taxonomy). Every datapoint carries `{source, fetchedAt}`. On failure the connector returns a typed
error and the UI says "unavailable"; the only non-fresh data ever shown is the last REAL fetch, flagged stale with its original time.
Nothing is enabled by default except the local sessions clock.

## What works with no provider and no key
| Connector | Notes |
|---|---|
| Market sessions | Fully local. Sydney/Tokyo/London/New York, editable hours and IANA zones, DST via Intl. Weekly gold closure defaults to Fri 17:00 to Sun 17:00 New York time (editable; confirm with your broker). Holidays are NOT built in: add closed windows yourself (`context.sessions.closedWindows`, ISO instants). |
| Related markets | Needs only the running MT5 terminal. You map DXY, US10Y, oil, S&P 500, Nasdaq, silver to your broker's symbol names (Settings > Connectors > "Find symbols"). No defaults, broker names differ. Reading a symbol adds it to MT5 Market Watch. |

## What needs the owner to supply a URL and maybe a key
| Connector | Needs |
|---|---|
| Economic calendar | A JSON URL from a provider you choose, plus a field mapping. |
| News | An RSS/Atom URL (no mapping needed) or a JSON URL plus mapping. |
| Sentiment | A JSON URL plus mapping. |

No provider API is built in or guessed. Respect each provider's terms; do not point these at sites that forbid automated access.
Keys: header value or `{{secret}}` inside the URL, saved through the encrypted secret store (same file as AI keys, `connector:` prefix),
never returned to the renderer or the AI.

## Mapping (JSON)
`{"itemsPath":"$.events[*]","fields":{"time":"$.date","currency":"$.country","title":"$.title","impact":"$.impact","forecast":"$.f"},"constants":{},"timeFormat":"auto","timeZone":"UTC","impactMap":{"red":"high"}}`
Paths: `$ .key ['key'] [0] [-1] [*] .* ..key` (no filters). Fields: calendar time/currency/title/impact/actual/forecast/previous;
news time/title/summary/url/source; sentiment source/instrument/longPct/shortPct/asOf. Dates without an offset use `timeZone`.
Rows failing Zod validation are dropped and counted; if none validate the connector reports `bad_response`.

## Preset
One template: Federal Reserve press releases RSS. **unverified: confirm terms and URL.** It was written from memory, never fetched by Aurum, and is never enabled automatically.

## AI tools (chartRead)
`get_sessions`, `get_calendar`, `get_news`, `get_sentiment`, `get_related_markets`. They answer "no_data_configured" when no connector is on. News text is flagged untrusted.

## Not verified
Nothing here was run against a live provider or a real MT5 terminal. Tests use a local mock HTTP server and a fake MT5 module.
