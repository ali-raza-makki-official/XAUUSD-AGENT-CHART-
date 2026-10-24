import { describe, expect, it } from 'vitest';
import { ConnectorError, ConnectorRegistry, TokenBucket, parseRetryAfter, type Connector, type ConnectorManifest } from '../src';

const manifest = (over: Partial<ConnectorManifest> = {}): ConnectorManifest => ({
  id: 'test.feed', name: 'Test feed', kind: 'news', version: '1', capabilities: ['news'], requiredSecrets: [], permissions: ['network'],
  rateLimit: { capacity: 2, refillPerMinute: 1 }, cacheTtlMs: 60_000, staleAfterMs: 300_000, ...over,
});

function fake(over: Partial<ConnectorManifest> = {}) {
  const st = { calls: 0, configured: true, next: (): Promise<string> => Promise.resolve('data-1') };
  const c: Connector<string> = {
    manifest: manifest(over),
    isConfigured: () => st.configured,
    async testConnection() { return { ok: true, at: 0, latencyMs: 1, detail: 'ok' }; },
    fetch: () => { st.calls++; return st.next(); },
  };
  return { c, st };
}

function setup(over: Partial<ConnectorManifest> = {}) {
  let now = 1_000_000;
  const persisted: string[] = [];
  const reg = new ConnectorRegistry({ now: () => now, onFetched: (id) => persisted.push(id) });
  const f = fake(over);
  reg.register(f.c);
  return { reg, f, persisted, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe('TokenBucket and Retry-After', () => {
  it('allows a burst, then says how long to wait', () => {
    const b = new TokenBucket(2, 1 / 60_000, 0);
    expect(b.take(0).ok).toBe(true);
    expect(b.take(0).ok).toBe(true);
    const r = b.take(0);
    expect(r).toEqual({ ok: false, waitMs: 60_000 });
    expect(b.take(60_000).ok).toBe(true);
  });
  it('parses seconds and HTTP dates and clamps', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60_000);
    expect(parseRetryAfter('999999999', 0)).toBe(86_400_000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe('ConnectorRegistry', () => {
  it('is off until enabled, and says not configured when it cannot run', async () => {
    const { reg, f } = setup();
    expect(await reg.read('test.feed')).toMatchObject({ ok: false, error: { code: 'disabled' } });
    reg.setEnabled('test.feed', true);
    f.st.configured = false;
    expect(await reg.read('test.feed')).toMatchObject({ ok: false, error: { code: 'not_configured' } });
    expect(f.st.calls).toBe(0);
    expect(await reg.read('nope')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });

  it('stamps results with source and fetchedAt, caches within the TTL, refetches after it', async () => {
    const { reg, f, tick, persisted } = setup();
    reg.setEnabled('test.feed', true);
    const a = await reg.read<string>('test.feed');
    expect(a).toMatchObject({ ok: true, data: 'data-1', source: 'Test feed', fetchedAt: 1_000_000, stale: false, fromCache: false });
    tick(10_000);
    expect(await reg.read('test.feed')).toMatchObject({ ok: true, fromCache: true, fetchedAt: 1_000_000 });
    expect(f.st.calls).toBe(1);
    tick(60_000);
    f.st.next = () => Promise.resolve('data-2');
    expect(await reg.read('test.feed')).toMatchObject({ data: 'data-2', fromCache: false });
    expect(persisted).toEqual(['test.feed', 'test.feed']);
  });

  it('flags data older than staleAfterMs as stale', async () => {
    const { reg, tick } = setup({ cacheTtlMs: 1_000_000, staleAfterMs: 5_000 });
    reg.setEnabled('test.feed', true);
    await reg.read('test.feed');
    tick(6_000);
    expect(await reg.read('test.feed')).toMatchObject({ ok: true, stale: true, fromCache: true });
    expect(reg.health('test.feed')?.stale).toBe(true);
  });

  it('on failure with a previous real fetch serves it flagged stale with the error; with none, a typed error and no data', async () => {
    const { reg, f, tick } = setup();
    reg.setEnabled('test.feed', true);
    f.st.next = () => Promise.reject(new ConnectorError('network', 'offline'));
    const none = await reg.read('test.feed');
    expect(none).toEqual({ ok: false, error: { code: 'network', message: 'offline' }, source: 'Test feed' });
    f.st.next = () => Promise.resolve('good');
    tick(61_000);
    await reg.read('test.feed');
    f.st.next = () => Promise.reject(new ConnectorError('upstream', 'HTTP 500'));
    tick(61_000);
    const r = await reg.read('test.feed');
    expect(r).toMatchObject({ ok: true, data: 'good', stale: true, fromCache: true, lastError: { code: 'upstream' } });
    expect((r as { fetchedAt: number }).fetchedAt).toBe(1_061_000); // original fetch time, not now
    expect(reg.health('test.feed')).toMatchObject({ errorStatus: { code: 'upstream' }, lastSuccessfulSync: 1_061_000 });
  });

  it('rate limits with a token bucket', async () => {
    const { reg, f, tick } = setup({ cacheTtlMs: 0 });
    reg.setEnabled('test.feed', true);
    expect((await reg.read('test.feed')).ok).toBe(true);
    expect((await reg.read('test.feed')).ok).toBe(true);
    const third = await reg.read('test.feed');
    expect(third).toMatchObject({ ok: true, stale: true, lastError: { code: 'rate_limited' } }); // served from the last real fetch
    expect(f.st.calls).toBe(2);
    expect(reg.health('test.feed')?.nextAllowedCall).toBe(1_060_000);
    tick(60_000);
    expect((await reg.read('test.feed')) as { fromCache: boolean }).toMatchObject({ fromCache: false });
    expect(f.st.calls).toBe(3);
  });

  it('honours Retry-After from the provider: no calls until the time has passed', async () => {
    const { reg, f, tick } = setup({ cacheTtlMs: 0, rateLimit: { capacity: 100, refillPerMinute: 100 } });
    reg.setEnabled('test.feed', true);
    f.st.next = () => Promise.reject(new ConnectorError('rate_limited', 'HTTP 429', 120_000));
    expect(await reg.read('test.feed')).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(f.st.calls).toBe(1);
    tick(60_000);
    const during = await reg.read('test.feed');
    expect(during).toMatchObject({ ok: false, error: { code: 'rate_limited', retryAfterMs: 60_000 } });
    expect(f.st.calls).toBe(1); // not called
    expect(reg.health('test.feed')?.nextAllowedCall).toBe(1_120_000);
    tick(60_001);
    f.st.next = () => Promise.resolve('back');
    expect(await reg.read('test.feed')).toMatchObject({ ok: true, data: 'back' });
  });

  it('shares one in-flight fetch between concurrent readers', async () => {
    const { reg, f } = setup({ cacheTtlMs: 0 });
    reg.setEnabled('test.feed', true);
    let release!: (v: string) => void;
    f.st.next = () => new Promise((r) => { release = r; });
    const p = [reg.read('test.feed'), reg.read('test.feed')];
    release('x');
    const out = await Promise.all(p);
    expect(f.st.calls).toBe(1);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it('tests a connection through the rate limiter and records it in health', async () => {
    const { reg, f } = setup();
    expect(await reg.test('test.feed')).toMatchObject({ ok: true });
    f.st.configured = false;
    expect(await reg.test('test.feed')).toMatchObject({ ok: false, error: { code: 'not_configured' } });
    expect(reg.health('test.feed')?.lastTest).toMatchObject({ ok: false });
  });

  it('seeds persisted data so a restart shows the last real fetch (flagged stale when old)', async () => {
    const { reg, tick } = setup({ cacheTtlMs: 0, staleAfterMs: 10_000 });
    reg.setEnabled('test.feed', true);
    reg.seed('test.feed', { data: 'old', fetchedAt: 900_000, source: 'Test feed' });
    tick(0);
    expect(reg.health('test.feed')).toMatchObject({ lastSuccessfulSync: 900_000, stale: true });
  });

  it('refuses invalid manifests', () => {
    const reg = new ConnectorRegistry();
    expect(() => reg.register({ ...fake().c, manifest: manifest({ id: 'Bad Id' }) })).toThrow();
  });
});
