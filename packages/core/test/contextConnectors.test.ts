import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectorRegistry, GenericConnectorSchema, MappingSchema, configIssues, createHttpGet, makeGenericConnector, makeRelatedMarketsConnector,
  makeSessionsConnector, ContextSettingsSchema, DEFAULT_SESSIONS_SETTINGS, CONNECTOR_PRESETS, type GenericConnectorConfig,
} from '../src';

/** Local mock provider. Test-only: nothing here ships or is used as data by the app. */
let server: Server;
let base = '';
const seen: { url: string; headers: IncomingMessage['headers'] }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, r) => r.end('{}');

beforeAll(async () => {
  server = createServer((req, res) => { seen.push({ url: req.url ?? '', headers: req.headers }); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const send = (status: number, body: string, headers: Record<string, string> = {}) => { handler = (_q, r) => { r.writeHead(status, headers); r.end(body); }; };
const secrets = new Map<string, string>();
const http = createHttpGet();

function calendarCfg(over: Partial<GenericConnectorConfig> = {}): GenericConnectorConfig {
  return GenericConnectorSchema.parse({
    id: 'calendar-mock', label: 'Mock calendar', kind: 'calendar', format: 'json', url: `${base}/cal`, refreshMinutes: 15,
    mapping: MappingSchema.parse({ itemsPath: '$.events[*]', fields: { time: '$.t', currency: '$.c', title: '$.n', impact: '$.i', forecast: '$.f' } }),
    ...over,
  });
}
const calendarBody = JSON.stringify({ events: [{ t: 1_790_000_000, c: 'USD', n: 'CPI', i: 'High', f: '0.3%' }, { t: 1_790_003_600, c: 'EUR', n: 'PMI', i: 'Low' }] });
const mk = (cfg: GenericConnectorConfig, now = () => 1_790_000_500_000) => makeGenericConnector(() => cfg as never, { http, getSecret: (id) => secrets.get(id) ?? null, now });

describe('generic HTTP/JSON connector against a local mock server', () => {
  it('fetches, maps, validates and stamps every item with source and fetchedAt', async () => {
    send(200, calendarBody, { 'content-type': 'application/json' });
    const feed = await mk(calendarCfg()).fetch();
    expect(feed.total).toBe(2);
    expect(feed.items[0]).toMatchObject({ currency: 'USD', title: 'CPI', impact: 'high', forecast: '0.3%', source: 'Mock calendar', fetchedAt: 1_790_000_500_000 });
    expect(feed.items.every((i) => i.source && i.fetchedAt)).toBe(true);
  });

  it('sends the auth header from the secret store and never from config', async () => {
    send(200, calendarBody);
    secrets.set('calendar-mock', 'Bearer s3cret-token');
    const cfg = calendarCfg({ authHeader: 'Authorization' });
    expect(JSON.stringify(cfg)).not.toContain('s3cret');
    await mk(cfg).fetch();
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer s3cret-token');
  });

  it('substitutes {{secret}} in the URL, and scrubs the secret from error messages', async () => {
    secrets.set('calendar-mock', 'KEY123');
    send(200, calendarBody);
    await mk(calendarCfg({ url: `${base}/cal?apikey={{secret}}` })).fetch();
    expect(seen.at(-1)!.url).toBe('/cal?apikey=KEY123');
    send(500, 'boom');
    const err = await mk(calendarCfg({ url: `${base}/cal?apikey={{secret}}` })).fetch().catch((e) => e);
    expect(err.code).toBe('upstream');
    expect(err.message).not.toContain('KEY123');
  });

  it('reports a missing key as unauthorized without calling the provider', async () => {
    secrets.delete('calendar-mock');
    const before = seen.length;
    const err = await mk(calendarCfg({ authHeader: 'X-Api-Key' })).fetch().catch((e) => e);
    expect(err).toMatchObject({ code: 'unauthorized' });
    expect(seen.length).toBe(before);
  });

  it('maps HTTP failures to the error taxonomy and honours Retry-After', async () => {
    send(401, '{}'); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'unauthorized' });
    send(429, '{}', { 'retry-after': '90' }); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'rate_limited', retryAfterMs: 90_000 });
    send(429, '{}'); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'rate_limited', retryAfterMs: 60_000 });
    send(503, '{}', { 'retry-after': '5' }); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'rate_limited', retryAfterMs: 5_000 });
    send(502, '{}'); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'upstream' });
    send(200, '<html>login</html>'); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'bad_response' });
    send(200, JSON.stringify({ unexpected: true })); expect(await mk(calendarCfg()).fetch().catch((e) => e)).toMatchObject({ code: 'bad_response' });
  });

  it('network failure is a typed error, not data', async () => {
    const dead = createServer(); await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port; dead.close();
    const err = await mk(calendarCfg({ url: `http://127.0.0.1:${port}/x` })).fetch().catch((e) => e);
    expect(err).toMatchObject({ code: 'network' });
  });

  it('refuses plain http to remote hosts and oversize responses', async () => {
    expect(configIssues(calendarCfg({ url: 'http://example.com/cal' })).join(' ')).toMatch(/https/);
    send(200, 'x'.repeat(2000));
    await expect(http(`${base}/big`, {}, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('is not configured until the mapping covers the required fields', () => {
    expect(configIssues(calendarCfg({ mapping: null })).join(' ')).toMatch(/mapping/);
    const partial = calendarCfg({ mapping: MappingSchema.parse({ itemsPath: '$.events[*]', fields: { time: '$.t', title: '$.n' } }) });
    expect(configIssues(partial).join(' ')).toMatch(/currency/);
    expect(mk(partial).isConfigured()).toBe(false);
  });

  it('reads RSS news through the same path', async () => {
    send(200, `<rss><channel><item><title>Gold edges up</title><link>https://example.test/a</link><pubDate>Fri, 23 Oct 2026 12:30:00 GMT</pubDate></item></channel></rss>`);
    const cfg = GenericConnectorSchema.parse({ id: 'news-rss', label: 'Mock RSS', kind: 'news', format: 'rss', url: `${base}/rss` });
    const feed = await makeGenericConnector(() => cfg as never, { http, getSecret: () => null }).fetch();
    expect(feed.items[0]).toMatchObject({ title: 'Gold edges up', source: 'Mock RSS', url: 'https://example.test/a' });
    expect(configIssues({ ...cfg, kind: 'calendar' })).toContain('RSS/Atom is supported for news only.');
  });

  it('testConnection succeeds only when real data validates', async () => {
    send(200, calendarBody);
    expect(await mk(calendarCfg()).testConnection()).toMatchObject({ ok: true, detail: expect.stringContaining('2 calendar items') });
    send(200, '{"events":[]}');
    expect(await mk(calendarCfg()).testConnection()).toMatchObject({ ok: false, error: { code: 'bad_response' } });
  });

  it('works through the registry: off by default, caching, stale on later failure, Retry-After blocks calls', async () => {
    let now = 1_790_000_500_000;
    const reg = new ConnectorRegistry({ now: () => now });
    const cfg = calendarCfg();
    reg.register(mk(cfg, () => now));
    send(200, calendarBody);
    expect(await reg.read('calendar-mock')).toMatchObject({ ok: false, error: { code: 'disabled' } });
    reg.setEnabled('calendar-mock', true);
    const a = await reg.read<{ items: unknown[] }>('calendar-mock');
    expect(a).toMatchObject({ ok: true, stale: false, source: 'Mock calendar' });
    now += 16 * 60_000;
    send(429, '{}', { 'retry-after': '600' });
    const b = await reg.read('calendar-mock');
    expect(b).toMatchObject({ ok: true, stale: true, fromCache: true, lastError: { code: 'rate_limited', retryAfterMs: 600_000 } });
    const n = seen.length;
    now += 60_000;
    await reg.read('calendar-mock');
    expect(seen.length).toBe(n);
  });
});

describe('presets and settings', () => {
  it('ships exactly one template, marked unverified, and defaults enable nothing external', () => {
    expect(CONNECTOR_PRESETS).toHaveLength(1);
    expect(CONNECTOR_PRESETS[0]!.note).toMatch(/^unverified: confirm terms and URL/);
    const d = ContextSettingsSchema.parse({});
    expect(d.connectors).toEqual([]);
    expect(d.relatedEnabled).toBe(false);
    expect(d.related.symbols).toEqual({});
    expect(GenericConnectorSchema.parse({ id: 'a1', label: 'x', kind: 'news', format: 'rss', url: 'https://example.test/f' }).enabled).toBe(false);
  });
});

describe('related markets connector', () => {
  const settings = { symbols: { dxy: 'DXY.f', oil: 'USOIL', silver: 'XAGUSD' } };
  it('is not configured until a symbol is mapped', () => {
    const c = makeRelatedMarketsConnector({ getSettings: () => ({ symbols: {} }), fetchQuotes: async () => ({ quotes: [] }) });
    expect(c.isConfigured()).toBe(false);
  });
  it('computes last and change from the real bid/ask/prevClose it was given, keeps partial failures visible', async () => {
    let asked: string[] = [];
    const c = makeRelatedMarketsConnector({
      getSettings: () => settings, now: () => 5_000,
      fetchQuotes: async (s) => { asked = s; return { quotes: [
        { symbol: 'DXY.f', ok: true, bid: 104.0, ask: 104.2, time: 1_790_000_000, prevClose: 103.0 },
        { symbol: 'USOIL', ok: false, error: "Symbol 'USOIL' not found on this broker." },
      ] }; },
    });
    const r = await c.fetch();
    expect(asked).toEqual(['DXY.f', 'USOIL', 'XAGUSD']);
    expect(r.quotes).toHaveLength(3);
    const dxy = r.quotes.find((q) => q.role === 'dxy')!;
    expect(dxy).toMatchObject({ ok: true, last: 104.1, source: 'MT5 DXY.f', fetchedAt: 5_000 });
    expect(dxy.changePct).toBeCloseTo(((104.1 - 103) / 103) * 100, 6);
    expect(r.quotes.find((q) => q.role === 'oil')).toMatchObject({ ok: false, last: null, changePct: null, error: expect.stringContaining('not found') });
    expect(r.quotes.find((q) => q.role === 'silver')).toMatchObject({ ok: false, error: 'Symbol not returned by MT5.' });
  });
  it('errors when nothing came back, or the bridge is down or sends junk', async () => {
    const mk2 = (f: () => Promise<unknown>) => makeRelatedMarketsConnector({ getSettings: () => settings, fetchQuotes: f });
    await expect(mk2(async () => ({ quotes: [{ symbol: 'DXY.f', ok: false, error: 'x' }] })).fetch()).rejects.toMatchObject({ code: 'upstream' });
    await expect(mk2(async () => { throw new Error('bridge HTTP 503'); }).fetch()).rejects.toMatchObject({ code: 'upstream', message: expect.stringContaining('bridge HTTP 503') });
    await expect(mk2(async () => ({ nope: 1 })).fetch()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(mk2(async () => ({ quotes: [{ symbol: 'DXY.f', ok: true, bid: 0, ask: 0 }] })).fetch()).rejects.toMatchObject({ code: 'upstream' });
  });
});

describe('sessions connector', () => {
  it('needs no network and no key', async () => {
    const c = makeSessionsConnector({ getSettings: () => DEFAULT_SESSIONS_SETTINGS, now: () => Date.parse('2026-01-14T14:30:00Z') });
    expect(c.manifest.permissions).toEqual(['local_clock']);
    expect(c.manifest.requiredSecrets).toEqual([]);
    const reg = new ConnectorRegistry({ now: () => Date.parse('2026-01-14T14:30:00Z') });
    reg.register(c, { enabled: true });
    const r = await reg.read<{ sessions: { id: string; active: boolean }[] }>('sessions');
    expect(r).toMatchObject({ ok: true, fetchedAt: Date.parse('2026-01-14T14:30:00Z') });
    expect(r.ok && r.data.sessions.filter((s) => s.active).map((s) => s.id).sort()).toEqual(['london', 'newyork']);
  });
});
