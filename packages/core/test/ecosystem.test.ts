import { describe, expect, it } from 'vitest';
import { auditEcosystem, isTransientStatus, retryDelayMs, type EcosystemInput } from '../src';

const base: EcosystemInput = {
  feed: { state: 'connected', tickAgeMs: 500 }, account: { demo: true }, tradingEnabled: true, assistantEnabled: false,
  ai: { provider: 'anthropic', hasKey: true, model: 'm', vision: true, secureStorage: true },
  whatsapp: { hasToken: true, state: 'polling', linked: true, lastError: null, remotePaused: false },
  connectors: [{ name: 'News', enabled: true, configured: true, issues: [], error: null, stale: false }],
  learning: { recordTicks: true, ticks: 10, memory: true, paperFinished: 3, paperOpen: 1 },
};
const lvl = (i: EcosystemInput, id: string) => auditEcosystem(i).find((c) => c.id === id)?.level;

describe('auditEcosystem', () => {
  it('is all ok for a healthy setup', () => expect(auditEcosystem(base).filter((c) => c.level === 'bad' || c.level === 'warn')).toEqual([]));
  it('flags a real account, dead feed, missing key, bad WhatsApp token and broken connector', () => {
    expect(lvl({ ...base, account: { demo: false } }, 'account')).toBe('bad');
    expect(lvl({ ...base, feed: { state: 'disconnected', tickAgeMs: null } }, 'feed')).toBe('bad');
    expect(lvl({ ...base, feed: { state: 'connected', tickAgeMs: 120_000 } }, 'feed')).toBe('warn');
    expect(lvl({ ...base, ai: { ...base.ai, hasKey: false } }, 'ai')).toBe('bad');
    expect(lvl({ ...base, whatsapp: { ...base.whatsapp!, state: 'auth_error' } }, 'wa')).toBe('bad');
    expect(lvl({ ...base, connectors: [{ name: 'News', enabled: true, configured: true, issues: [], error: 'HTTP 500', stale: false }] }, 'conn-News')).toBe('warn');
    expect(lvl({ ...base, learning: { ...base.learning, recordTicks: false } }, 'ticks')).toBe('off');
  });
});
describe('retry policy', () => {
  it('retries only transient statuses', () => { expect([429, 503, 529].every(isTransientStatus)).toBe(true); expect([400, 401, 403, 404].some(isTransientStatus)).toBe(false); });
  it('honours Retry-After, else backs off exponentially with a cap', () => {
    expect(retryDelayMs(0, '3')).toBe(3000);
    expect(retryDelayMs(0, '999')).toBe(20_000);
    expect(retryDelayMs(2, null, () => 0)).toBe(4000);
    expect(retryDelayMs(10, null, () => 0.9)).toBe(20_000);
  });
});
