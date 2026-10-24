import { z } from 'zod';
import {
  ConnectorError, parseRetryAfter, stampAll,
  type ConnectionTest, type Connector, type ConnectorManifest, type Stamped,
} from './connectors';
import {
  MappingSchema, NoTradeRuleSchema, extractRows, feedToNews, mapRows, parseFeed, requireItems,
  type CalendarEvent, type Mapping, type NewsItem, type SentimentReading,
} from './marketContext';
import { SessionsSettingsSchema, sessionsSnapshot, type SessionsSettings, type SessionsSnapshot } from './sessions';

/** Connectors for market context. Transport is injected, so everything here is testable against a local mock server. */

// ---- HTTP transport ------------------------------------------------------------------------------

export interface HttpResponse { status: number; headers: Record<string, string>; text: string; finalUrl: string }
export type HttpGet = (url: string, headers: Record<string, string>, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<HttpResponse>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** https everywhere; plain http only to this machine (a local test server or a local proxy). */
export function assertSafeUrl(u: string): URL {
  let url: URL;
  try { url = new URL(u); } catch { throw new ConnectorError('not_configured', 'The URL is not valid.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new ConnectorError('not_configured', 'The URL must use https (http is allowed only for localhost).');
  }
  return url;
}

export function createHttpGet(fetchImpl: typeof fetch = fetch): HttpGet {
  return async (url, headers, opts = {}) => {
    const { timeoutMs = 15_000, maxBytes = 3_000_000 } = opts;
    assertSafeUrl(url);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.5', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ConnectorError('timeout', `No answer within ${Math.round(timeoutMs / 1000)}s.`);
      throw new ConnectorError('network', `Could not reach the server: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`);
    }
    if (res.url) assertSafeUrl(res.url); // a redirect must not downgrade to plain http
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { void reader.cancel(); throw new ConnectorError('bad_response', `Response is larger than ${Math.round(maxBytes / 1e6)} MB.`); }
        chunks.push(value);
      }
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const ch of chunks) { all.set(ch, off); off += ch.byteLength; }
    const text = new TextDecoder().decode(all);
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return { status: res.status, headers: h, text, finalUrl: res.url || url };
  };
}

/** Map a non-2xx response into the shared error taxonomy. */
export function httpError(res: HttpResponse, now: number): ConnectorError | null {
  if (res.status >= 200 && res.status < 300) return null;
  const ra = parseRetryAfter(res.headers['retry-after'], now);
  if (res.status === 401 || res.status === 403) return new ConnectorError('unauthorized', `The provider refused access (HTTP ${res.status}). Check the key or header.`);
  if (res.status === 429) return new ConnectorError('rate_limited', 'The provider says too many requests (HTTP 429).', ra ?? 60_000);
  if (res.status === 503 && ra !== null) return new ConnectorError('rate_limited', 'The provider is busy (HTTP 503) and asked us to wait.', ra);
  if (res.status >= 500) return new ConnectorError('upstream', `The provider had an error (HTTP ${res.status}).`);
  return new ConnectorError('upstream', `Unexpected answer from the provider (HTTP ${res.status}).`);
}

// ---- generic HTTP/JSON and RSS/Atom connector ----------------------------------------------------

export const SECRET_PLACEHOLDER = '{{secret}}';
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;

export const GenericConnectorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,63}$/),
  label: z.string().min(1).max(60),
  kind: z.enum(['calendar', 'news', 'sentiment']),
  format: z.enum(['json', 'rss']),
  /** May contain {{secret}}, replaced with the stored secret at call time. The secret itself is never in config. */
  url: z.string().max(800),
  /** Name of the header that carries the secret, e.g. Authorization or X-Api-Key. The value lives in the secret store. */
  authHeader: z.string().regex(HEADER_NAME).nullable().default(null),
  mapping: MappingSchema.nullable().default(null),
  refreshMinutes: z.number().int().min(1).max(1440).default(30),
  enabled: z.boolean().default(false),
  note: z.string().max(300).default(''),
});
export type GenericConnectorConfig = z.infer<typeof GenericConnectorSchema>;

const REQUIRED_FIELDS: Record<GenericConnectorConfig['kind'], string[]> = {
  calendar: ['time', 'title', 'currency'],
  news: ['time', 'title'],
  sentiment: ['instrument', 'longPct', 'shortPct'],
};

/** Human-readable reasons the connector cannot run yet (empty = configured). */
export function configIssues(c: GenericConnectorConfig): string[] {
  const out: string[] = [];
  if (!c.url.trim()) out.push('Enter the feed URL.');
  else { try { assertSafeUrl(c.url.replaceAll(SECRET_PLACEHOLDER, 'x')); } catch (e) { out.push((e as Error).message); } }
  if (c.format === 'rss' && c.kind !== 'news') out.push('RSS/Atom is supported for news only.');
  if (c.format === 'json') {
    if (!c.mapping) out.push('Add a field mapping for the JSON response.');
    else for (const f of REQUIRED_FIELDS[c.kind]) if (!c.mapping.fields[f] && c.mapping.constants[f] === undefined) out.push(`Map the "${f}" field (a path, or a fixed value).`);
  }
  return out;
}

export interface GenericDeps { http: HttpGet; getSecret(id: string): string | null; now?: () => number }
export interface ContextFeed<T> { items: Stamped<T>[]; total: number; rejected: number }
type FeedItemFor<K extends GenericConnectorConfig['kind']> = K extends 'calendar' ? CalendarEvent : K extends 'news' ? NewsItem : SentimentReading;

function scrub(msg: string, secret: string | null): string { return secret ? msg.split(secret).join('***').split(encodeURIComponent(secret)).join('***') : msg; }

export function genericManifest(c: GenericConnectorConfig): ConnectorManifest {
  const needsSecret = c.authHeader !== null || c.url.includes(SECRET_PLACEHOLDER);
  return {
    id: c.id, name: c.label, kind: c.kind, version: '1',
    capabilities: [c.kind, c.format],
    requiredSecrets: needsSecret ? ['api_key'] : [],
    permissions: ['network'],
    rateLimit: { capacity: 3, refillPerMinute: Math.min(6000, 2 / c.refreshMinutes) },
    cacheTtlMs: c.refreshMinutes * 60_000,
    staleAfterMs: c.refreshMinutes * 60_000 * 3,
  };
}

export function makeGenericConnector<K extends GenericConnectorConfig['kind']>(
  getConfig: () => GenericConnectorConfig & { kind: K }, deps: GenericDeps,
): Connector<ContextFeed<FeedItemFor<K>>> {
  const now = deps.now ?? Date.now;
  const c0 = getConfig();
  const run = async (): Promise<ContextFeed<FeedItemFor<K>>> => {
    const c = getConfig();
    const issues = configIssues(c);
    if (issues.length) throw new ConnectorError('not_configured', issues.join(' '));
    const needsSecret = c.authHeader !== null || c.url.includes(SECRET_PLACEHOLDER);
    const secret = needsSecret ? deps.getSecret(c.id) : null;
    if (needsSecret && !secret) throw new ConnectorError('unauthorized', 'This connector needs its key, but none is saved. Add it in the connector settings.');
    const url = secret ? c.url.replaceAll(SECRET_PLACEHOLDER, encodeURIComponent(secret)) : c.url;
    const headers: Record<string, string> = {};
    if (c.authHeader && secret) headers[c.authHeader] = secret;
    let res: HttpResponse;
    try { res = await deps.http(url, headers); } catch (e) {
      if (e instanceof ConnectorError) throw new ConnectorError(e.code, scrub(e.message, secret), e.retryAfterMs);
      throw new ConnectorError('network', scrub(e instanceof Error ? e.message : String(e), secret));
    }
    const err = httpError(res, now());
    if (err) throw err;
    const label = c.label;
    let mapped: { items: unknown[]; total: number; rejected: number };
    if (c.format === 'rss') {
      const m = feedToNews(parseFeed(res.text), label, c.mapping ?? undefined);
      mapped = m;
    } else {
      let json: unknown;
      try { json = JSON.parse(res.text); } catch { throw new ConnectorError('bad_response', 'The response is not valid JSON.'); }
      const mapping = c.mapping as Mapping;
      const rows = extractRows(json, mapping);
      mapped = c.kind === 'calendar' ? mapRows('calendar', rows, mapping, label) : c.kind === 'news' ? mapRows('news', rows, mapping, label) : mapRows('sentiment', rows, mapping, label);
    }
    const items = requireItems(mapped as never, label) as object[];
    const fetchedAt = now();
    return { items: stampAll(items, label, fetchedAt) as Stamped<FeedItemFor<K>>[], total: mapped.total, rejected: mapped.rejected };
  };
  return {
    manifest: genericManifest(c0),
    isConfigured: () => configIssues(getConfig()).length === 0,
    async testConnection(): Promise<ConnectionTest> {
      const t0 = now();
      try {
        const r = await run();
        return { ok: true, at: now(), latencyMs: now() - t0, detail: `${r.items.length} ${c0.kind} items read${r.rejected ? `, ${r.rejected} rows skipped (did not match the mapping)` : ''}.` };
      } catch (e) {
        return { ok: false, at: now(), error: e instanceof ConnectorError ? e.toInfo() : { code: 'internal', message: String(e) } };
      }
    },
    fetch: run,
  };
}

/** Fed press releases RSS. A template only: never enabled by itself and added by the user on request. */
export const CONNECTOR_PRESETS: { presetId: string; label: string; kind: 'news'; format: 'rss'; url: string; note: string }[] = [
  {
    presetId: 'fed-press', label: 'Federal Reserve press releases (RSS)', kind: 'news', format: 'rss',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    note: 'unverified: confirm terms and URL before enabling. Written from memory; Aurum has not fetched it.',
  },
];

// ---- related markets (through the MT5 bridge) ----------------------------------------------------

export const RELATED_ROLES = [
  { id: 'dxy', label: 'US Dollar Index', needles: 'DXY,USDX,DX' },
  { id: 'us10y', label: 'US 10Y yield', needles: 'US10Y,TNOTE,UST10,TBOND' },
  { id: 'oil', label: 'Oil (WTI / Brent)', needles: 'WTI,USOIL,XTI,BRENT,XBR,UKOIL' },
  { id: 'sp500', label: 'S&P 500', needles: 'US500,SPX,SP500' },
  { id: 'nasdaq', label: 'Nasdaq 100', needles: 'USTEC,NAS100,NDX,US100' },
  { id: 'silver', label: 'Silver', needles: 'XAG,SILVER' },
] as const;
export type RelatedRole = (typeof RELATED_ROLES)[number]['id'];

export const RelatedSettingsSchema = z.object({
  /** Role -> the symbol name your broker uses. Empty = not mapped. Names differ per broker, so there are no defaults. */
  symbols: z.partialRecord(z.enum(RELATED_ROLES.map((r) => r.id) as [RelatedRole, ...RelatedRole[]]), z.string().max(32)).default({}),
});
export type RelatedSettings = z.infer<typeof RelatedSettingsSchema>;

const RawQuoteSchema = z.object({
  symbol: z.string(),
  ok: z.boolean(),
  bid: z.number().nullish(),
  ask: z.number().nullish(),
  time: z.number().nullish(),
  prevClose: z.number().nullish(),
  error: z.string().nullish(),
});
export const QuotesResponseSchema = z.object({ quotes: z.array(RawQuoteSchema) });

export interface RelatedQuote {
  role: RelatedRole;
  label: string;
  symbol: string;
  ok: boolean;
  bid: number | null;
  ask: number | null;
  last: number | null;
  prevClose: number | null;
  /** (last - prevClose) / prevClose * 100, computed here from the two real numbers. */
  changePct: number | null;
  /** Broker tick time, unix seconds. */
  quoteTime: number | null;
  error: string | null;
}
export interface RelatedMarkets { quotes: Stamped<RelatedQuote>[] }

export function makeRelatedMarketsConnector(deps: { getSettings(): RelatedSettings; fetchQuotes(symbols: string[]): Promise<unknown>; now?: () => number }): Connector<RelatedMarkets> {
  const now = deps.now ?? Date.now;
  const mapped = () => RELATED_ROLES.flatMap((r) => { const s = deps.getSettings().symbols[r.id]?.trim(); return s ? [{ ...r, symbol: s }] : []; });
  const run = async (): Promise<RelatedMarkets> => {
    const roles = mapped();
    if (!roles.length) throw new ConnectorError('not_configured', 'No related-market symbols are mapped yet.');
    let raw: unknown;
    try { raw = await deps.fetchQuotes([...new Set(roles.map((r) => r.symbol))]); } catch (e) {
      throw new ConnectorError('upstream', `MT5 bridge: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = QuotesResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorError('bad_response', 'The MT5 bridge sent quotes in an unexpected shape.');
    const by = new Map(parsed.data.quotes.map((q) => [q.symbol, q]));
    const fetchedAt = now();
    const quotes: Stamped<RelatedQuote>[] = roles.map((r) => {
      const q = by.get(r.symbol);
      const ok = !!q && q.ok && (q.bid ?? 0) + (q.ask ?? 0) > 0;
      const bid = ok ? q!.bid ?? null : null;
      const ask = ok ? q!.ask ?? null : null;
      const last = bid === null && ask === null ? null : (bid && ask ? (bid + ask) / 2 : (bid || ask));
      const prev = ok ? q!.prevClose ?? null : null;
      return {
        role: r.id, label: r.label, symbol: r.symbol, ok, bid, ask, last: last ?? null, prevClose: prev,
        changePct: last && prev && prev > 0 ? ((last - prev) / prev) * 100 : null,
        quoteTime: ok ? q!.time ?? null : null,
        error: ok ? null : q?.error ?? 'Symbol not returned by MT5.',
        source: `MT5 ${r.symbol}`, fetchedAt,
      };
    });
    if (!quotes.some((q) => q.ok)) throw new ConnectorError('upstream', `MT5 returned no quote for any mapped symbol (${quotes.map((q) => `${q.symbol}: ${q.error}`).join('; ')}).`);
    return { quotes };
  };
  return {
    manifest: {
      id: 'related-markets', name: 'Related markets (MT5)', kind: 'related_markets', version: '1',
      capabilities: ['quotes'], requiredSecrets: [], permissions: ['mt5_bridge'],
      rateLimit: { capacity: 6, refillPerMinute: 12 }, cacheTtlMs: 10_000, staleAfterMs: 120_000,
    },
    isConfigured: () => mapped().length > 0,
    async testConnection(): Promise<ConnectionTest> {
      const t0 = now();
      try {
        const r = await run();
        const bad = r.quotes.filter((q) => !q.ok);
        return { ok: true, at: now(), latencyMs: now() - t0, detail: `${r.quotes.length - bad.length}/${r.quotes.length} symbols returned a quote${bad.length ? ` (no quote: ${bad.map((b) => b.symbol).join(', ')})` : ''}.` };
      } catch (e) {
        return { ok: false, at: now(), error: e instanceof ConnectorError ? e.toInfo() : { code: 'internal', message: String(e) } };
      }
    },
    fetch: run,
  };
}

// ---- sessions (local, no API) --------------------------------------------------------------------

export const SESSIONS_SOURCE = 'Aurum local clock (IANA time zones)';
export function makeSessionsConnector(deps: { getSettings(): SessionsSettings; now?: () => number }): Connector<SessionsSnapshot> {
  const now = deps.now ?? Date.now;
  return {
    manifest: {
      id: 'sessions', name: SESSIONS_SOURCE, kind: 'calendar', version: '1',
      capabilities: ['sessions', 'overlaps', 'market_hours'], requiredSecrets: [], permissions: ['local_clock'],
      rateLimit: { capacity: 600, refillPerMinute: 600 }, cacheTtlMs: 0, staleAfterMs: 60_000,
    },
    isConfigured: () => true,
    async testConnection(): Promise<ConnectionTest> {
      const t = now();
      return { ok: true, at: t, latencyMs: 0, detail: 'Local clock. No network is used.' };
    },
    fetch: async () => sessionsSnapshot(deps.getSettings(), now()),
  };
}

// ---- settings ------------------------------------------------------------------------------------

export const ContextSettingsSchema = z.object({
  sessionsEnabled: z.boolean().default(true),
  relatedEnabled: z.boolean().default(false),
  sessions: SessionsSettingsSchema.default(() => SessionsSettingsSchema.parse({})),
  related: RelatedSettingsSchema.default(() => RelatedSettingsSchema.parse({})),
  noTrade: NoTradeRuleSchema.default(() => NoTradeRuleSchema.parse({})),
  connectors: z.array(GenericConnectorSchema).max(12).default([]),
});
export type ContextSettings = z.infer<typeof ContextSettingsSchema>;
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = ContextSettingsSchema.parse({});
