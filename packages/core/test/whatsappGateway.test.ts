import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { WhatsAppPipeline, WhatsAppSettingsSchema, stubActionHandler, type UpdatesBatch } from '../src';
import { WhatsAppGateway } from '../../../apps/desktop/src/main/whatsapp';
import { SqliteWhatsAppStore } from '../../../apps/desktop/src/main/whatsappStore';
import { CREATOR, MockWhatsApp, errors } from './helpers/mockWhatsApp';

// TEST-ONLY: a local mock of the documented wire format. No real WhatsApp service was contacted.
const waitFor = async (fn: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await new Promise((r) => setTimeout(r, 5)); } };

let mock: MockWhatsApp;
let gw: WhatsAppGateway | null = null;
beforeEach(async () => { mock = new MockWhatsApp(); await mock.start(); });
afterEach(async () => { await gw?.stop(); gw = null; await mock.stop(); });

function build(o: { store?: SqliteWhatsAppStore; onBatch?: (b: UpdatesBatch) => Promise<void>; token?: string | null } = {}) {
  const store = o.store ?? new SqliteWhatsAppStore(new DatabaseSync(':memory:'));
  store.setLink({ status: 'linked', userId: CREATOR, linkedAt: Date.now() });
  let clock = Date.now();
  const sleeps: number[] = [];
  const executed: string[] = [];
  const g: WhatsAppGateway = new WhatsAppGateway({
    baseUrl: mock.baseUrl, getToken: () => (o.token === undefined ? mock.token : o.token), store, pollTimeoutSec: 0,
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; await new Promise((r) => setTimeout(r, 1)); }, rand: () => 0.5,
    onBatch: o.onBatch ?? (async (b) => { await pipeline.ingest(b.messages).then(({ work }) => pipeline.enqueueWork(work)); }),
  });
  const pipeline: WhatsAppPipeline = new WhatsAppPipeline({
    store, actions: { ...stubActionHandler, price: async () => 'GOLD 3350.10', pause: async () => { executed.push('pause'); return 'Paused.'; } },
    ai: { handle: async () => ({ text: 'ok' }) }, randomDigits: (n) => '4'.repeat(n),
    settings: () => WhatsAppSettingsSchema.parse({ permission: 'ask' }), send: g.sendReply, markRead: g.markRead,
  });
  gw = g;
  return { g, store, sleeps, executed, pipeline };
}

describe('poll loop against the mock server', () => {
  it('first poll omits offset, stores a 64-bit next_offset as a string and resumes from it', async () => {
    const { g, store } = build();
    g.start();
    await waitFor(() => mock.count('GET /updates') >= 1);
    expect(mock.reqs('GET /updates')[0]!.query.has('offset')).toBe(false);
    expect(mock.reqs('GET /updates')[0]!.query.get('limit')).toBe('50');
    mock.pushText('/price');
    await waitFor(() => mock.sent.length >= 1);
    expect(mock.sent[0].text.body).toBe('GOLD 3350.10');
    expect(mock.sent[0].to).toBe(CREATOR);
    await waitFor(() => store.getOffset() !== null);
    expect(store.getOffset()).toBe('9223372036854770001');
    await waitFor(() => mock.reqs('GET /updates').some((r) => r.query.get('offset') === '9223372036854770001'));
    expect(mock.requests.every((r) => r.headers.authorization === `Bearer ${mock.token}`)).toBe(true);
  });

  it('empty 204 responses are normal and keep the offset', async () => {
    const { g, store } = build();
    store.setOffset('42');
    g.start();
    await waitFor(() => mock.count('GET /updates') >= 3);
    expect(store.getOffset()).toBe('42');
    expect(g.status().state).toBe('polling');
    expect(g.status().lastSyncAt).not.toBeNull();
  });

  it('409 (replaced poll): one short retry, then it stops and reports a conflict instead of fighting', async () => {
    const { g, sleeps } = build();
    mock.force('GET /updates', errors.replaced(), errors.replaced());
    g.start();
    await waitFor(() => g.status().state === 'conflict');
    expect(sleeps).toContain(10_000);
    expect(g.isRunning).toBe(false);
    const n = mock.count('GET /updates');
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.count('GET /updates')).toBe(n);
  });

  it('429 on a poll backs off exponentially and reuses the same offset', async () => {
    const { g, store, sleeps } = build();
    store.setOffset('77');
    mock.force('GET /updates', errors.tooMany(), errors.tooMany());
    g.start();
    await waitFor(() => mock.count('GET /updates') >= 4);
    const offsets = mock.reqs('GET /updates').map((r) => r.query.get('offset'));
    expect(new Set(offsets)).toEqual(new Set(['77']));
    const backoffs = sleeps.filter((s) => s >= 1000 && s <= 60_000);
    expect(backoffs[1]!).toBeGreaterThan(backoffs[0]!);
  });

  it('an invalid token stops the loop with an auth error and never leaks the token', async () => {
    const { g } = build({ token: 'wrong-token-XYZ' });
    g.start();
    await waitFor(() => g.status().state === 'auth_error');
    expect(JSON.stringify(g.status())).not.toContain('wrong-token-XYZ');
    expect(g.status().lastError?.message).toMatch(/token/i);
  });

  it('delivery and read statuses update the history of the matching outbound message', async () => {
    const { g, store, pipeline } = build();
    g.start();
    await waitFor(() => mock.count('GET /updates') >= 1);
    mock.pushText('/price');
    await waitFor(() => mock.sent.length === 1);
    await pipeline.idle();
    mock.pushStatus('wamid.OUT1', 'delivered');
    mock.pushStatus('wamid.OUT1', 'read');
    await waitFor(() => store.listHistory(20).some((h) => h.direction === 'out' && h.status === 'read'));
  });
});

describe('end to end safety through the gateway', () => {
  it('a duplicate message (same wamid delivered twice) is executed once', async () => {
    const { g, executed } = build();
    g.start();
    await waitFor(() => mock.count('GET /updates') >= 1);
    mock.pushText('/pause', { id: 'wamid.DUP' });
    mock.pushText('/pause', { id: 'wamid.DUP' });
    await waitFor(() => executed.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(executed).toEqual(['pause']);
  });

  it('an expired backlog after a restart is summarised, never executed', async () => {
    const store = new SqliteWhatsAppStore(new DatabaseSync(':memory:'));
    mock.pushText('/pause', { ageSec: 3600 });
    mock.pushText('/pause', { ageSec: 900 });
    store.setOffset('0'); // the stored pointer from before the app was closed
    const { g, executed } = build({ store });
    g.start();
    await waitFor(() => mock.sent.length >= 1);
    expect(executed).toEqual([]);
    expect(mock.sent[0].text.body).toMatch(/2 messages arrived/);
    expect(mock.sent[0].text.body).toMatch(/did NOT act/);
    expect(mock.sent).toHaveLength(1);
  });

  it('a trade-related send that gets a 500 is unknown and is sent exactly once', async () => {
    const { g } = build();
    mock.force('POST /messages', errors.server(), errors.server());
    const res = await g.sendReply({ to: CREATOR, text: 'Closed ticket 1', kind: 'action_result', tradeRelated: true, priority: 'critical' });
    expect(res.status).toBe('unknown');
    expect(mock.count('POST /messages')).toBe(1);
  });

  it('a non-trade 500 gets one retry; a 503/131016 is re-sent; 403 is not retried', async () => {
    const { g } = build();
    mock.force('POST /messages', errors.server());
    expect((await g.sendReply({ to: CREATOR, text: 'info', kind: 'x', tradeRelated: false, priority: 'normal' })).status).toBe('sent');
    expect(mock.count('POST /messages')).toBe(2);
    mock.force('POST /messages', errors.notAccepted());
    expect((await g.sendReply({ to: CREATOR, text: 'info2', kind: 'x', tradeRelated: true, priority: 'normal' })).status).toBe('sent');
    const before = mock.count('POST /messages');
    const bad = await g.sendReply({ to: 'user:111', text: 'nope', kind: 'x', tradeRelated: false, priority: 'normal' });
    expect(bad.status).toBe('failed');
    expect(mock.count('POST /messages') - before).toBe(1);
  });

  it('rate limit: 14 queued sends never exceed 12 per (fake) minute and none is lost', async () => {
    const { g, sleeps } = build();
    mock.enforceRate = false; // the mock's own limiter runs on the real clock; this test runs on the gateway's fake clock
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => g.sendReply({ to: CREATOR, text: `m${i}`, kind: 'x', tradeRelated: false, priority: 'normal' })));
    expect(results.every((r) => r.status === 'sent')).toBe(true);
    expect(mock.sent.map((s) => s.text.body)).toEqual(Array.from({ length: 14 }, (_, i) => `m${i}`)); // order kept
    expect(sleeps.some((s) => s > 0 && s <= 60_000)).toBe(true); // the 12th send waited for the window
    expect(g.status().rate.messages.limit).toBe(11); // 12/min minus a safety margin
  });

  it('long text is split to 4096-char messages in order', async () => {
    const { g } = build();
    await g.sendReply({ to: CREATOR, text: `${'word '.repeat(2000)}`, kind: 'x', tradeRelated: false, priority: 'normal' });
    expect(mock.sent.length).toBe(3);
    expect(mock.sent.every((s) => s.text.body.length <= 4096)).toBe(true);
  });

  it('sends an image through upload then message, with caption overflow as a follow-up', async () => {
    const { g } = build();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const res = await g.sendReply({ to: CREATOR, text: 'x'.repeat(1500), images: [{ bytes, mimeType: 'image/png' }], kind: 'chart', tradeRelated: false, priority: 'normal' });
    expect(res.status).toBe('sent');
    expect(mock.sent[0].type).toBe('image');
    expect(mock.sent[0].image.caption.length).toBeLessThanOrEqual(1024);
    expect(mock.sent[1].type).toBe('text');
    expect(Buffer.from(mock.media.get(mock.sent[0].image.id)!.bytes)).toEqual(Buffer.from(bytes));
  });

  it('downloads inbound media and verifies SHA-256; a tampered digest is rejected', async () => {
    const { g } = build();
    const bytes = Buffer.from('screenshot-bytes');
    mock.media.set('img1', { bytes, mime: 'image/jpeg' });
    const b64 = createHash('sha256').update(bytes).digest('base64');
    const got = await g.downloadMedia({ id: 'img1', mimeType: 'image/jpeg', sha256Base64: b64, filename: undefined, caption: undefined }, 'image');
    expect(Buffer.from(got.bytes)).toEqual(bytes);
    await waitFor(() => mock.deleted.includes('img1'));
    mock.media.set('img2', { bytes, mime: 'image/jpeg', hexOverride: 'a'.repeat(64) });
    await expect(g.downloadMedia({ id: 'img2', mimeType: 'image/jpeg', sha256Base64: b64, filename: undefined, caption: undefined }, 'image')).rejects.toThrow(/SHA-256/);
  });

  it('read receipt with typing indicator hits /statuses', async () => {
    const { g } = build();
    await g.markRead('wamid.IN1', true);
    expect(mock.statuses[0]).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1', typing_indicator: { type: 'text' } });
  });
});
