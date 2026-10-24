import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  OutboundQueue, RateLimiter, SendRequestSchema, acceptNextOffset, backoffDelay, base64ToHex, compareOffsets, isValidOffset, mapError, mediaRequest, parseUpdatesBody, planPoll,
  readReceiptRequest, retryPolicy, safeEqual, sha256Hex, splitCaption, splitText, textRequest, validateOutboundMedia, verifyMediaDigest,
  type OutboundJob, type SendOutcome, type WaError,
} from '../src';

const USER = 'user:50972923564215';

describe('sha256 and media digests', () => {
  it('matches node:crypto for several lengths (block boundaries included)', () => {
    for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'));
    }
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('verifies against base64 (message) and hex (media endpoint) digests and rejects a mismatch or a missing digest', () => {
    const bytes = new TextEncoder().encode('chart screenshot bytes');
    const hex = createHash('sha256').update(bytes).digest('hex');
    const b64 = createHash('sha256').update(bytes).digest('base64');
    expect(base64ToHex(b64)).toBe(hex);
    expect(verifyMediaDigest(bytes, { base64: b64, hex })).toEqual({ ok: true });
    expect(verifyMediaDigest(bytes, { hex })).toEqual({ ok: true });
    expect(verifyMediaDigest(bytes, { base64: b64, hex: 'a'.repeat(64) }).ok).toBe(false);
    expect(verifyMediaDigest(new Uint8Array([1]), { base64: b64 }).ok).toBe(false);
    expect(verifyMediaDigest(bytes, {}).ok).toBe(false);
  });
  it('safeEqual', () => {
    expect(safeEqual('4821', '4821')).toBe(true);
    expect(safeEqual('4821', '4822')).toBe(false);
    expect(safeEqual('482', '4821')).toBe(false);
  });
});

describe('request schemas', () => {
  it('builds valid text, image and document requests', () => {
    expect(textRequest(USER, 'hi', 'wamid.X')).toMatchObject({ type: 'text', text: { body: 'hi' }, context: { message_id: 'wamid.X' } });
    expect(mediaRequest(USER, 'image', 'm1', { caption: 'c' })).toMatchObject({ type: 'image', image: { id: 'm1', caption: 'c' } });
    expect(mediaRequest(USER, 'document', 'm2', { filename: 'r.pdf' })).toMatchObject({ document: { id: 'm2', filename: 'r.pdf' } });
  });
  it('rejects what the platform would reject with 400', () => {
    const base = { messaging_product: 'whatsapp', to: USER };
    expect(SendRequestSchema.safeParse({ ...base, type: 'text', text: { body: 'x'.repeat(4097) } }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ ...base, type: 'image', image: { id: 'm', caption: 'x'.repeat(1025) } }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ ...base, to: 'agent:123', type: 'text', text: { body: 'x' } }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ ...base, to: '+4915112345', type: 'text', text: { body: 'x' } }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ ...base, type: 'reaction', reaction: {} }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ ...base, type: 'audio', audio: { id: 'a', caption: 'no captions on audio' } }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ ...base, type: 'image' }).success).toBe(false);
  });
  it('read receipt with and without the typing indicator', () => {
    expect(readReceiptRequest('wamid.A', false)).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.A' });
    expect(readReceiptRequest('wamid.A', true).typing_indicator).toEqual({ type: 'text' });
  });
  it('media limits from the manual', () => {
    expect(validateOutboundMedia('image', 'image/png', 4 * 1024 * 1024)).toBeNull();
    expect(validateOutboundMedia('image', 'image/png', 6 * 1024 * 1024)).toMatch(/limit/);
    expect(validateOutboundMedia('image', 'image/gif', 1000)).toMatch(/not accepted/);
    expect(validateOutboundMedia('document', 'application/pdf', 15 * 1024 * 1024)).toBeNull();
    expect(validateOutboundMedia('sticker', 'image/webp', 600 * 1024)).toMatch(/limit/);
  });
});

describe('updates parsing and offsets', () => {
  const text = (extra = '', next = '1287') => `{"object":"whatsapp_agent_platform","entry":[{"id":"123456789","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"wa_id":"${USER}","profile":{"name":"Alex"}}],"messages":[
    {"from":"${USER}","id":"wamid.A","timestamp":"1736844652","type":"text","text":{"body":"Hello agent"}},
    {"from":"${USER}","id":"wamid.B","timestamp":"1736844653","type":"audio","audio":{"id":"v1","mime_type":"audio/ogg","sha256":"h2Es2hY3zgogBRD6H18H56MI1WEVYK73ScITHR/3wa4=","voice":true}},
    {"from":"${USER}","id":"wamid.C","timestamp":"1736844654","type":"image","image":{"id":"i1","mime_type":"image/jpeg","sha256":"qMVn+oGMEIV+My80Bie9mw1IYstCsS+jX78zoLErQak=","caption":"look at this"},"context":{"id":"wamid.Q","from":"agent:123456789"}},
    {"from":"${USER}","id":"wamid.D","timestamp":"1736844655","type":"reaction","reaction":{"message_id":"wamid.A","emoji":""}},
    {"from":"${USER}","id":"wamid.E","timestamp":"1736844656","type":"audio","audio":{"id":"a2","mime_type":"audio/mpeg"}},
    {"id":"broken-no-from"}${extra}
  ],"statuses":[{"id":"wamid.OUT1","status":"read","recipient_id":"${USER}","timestamp":"1736844660"},{"id":"wamid.OUT2","status":"delivered","recipient_id":"${USER}","timestamp":"1736844661"}]}}]}],"next_offset":${next}}`;

  it('normalises text, voice note, image with context, reaction, plain audio and statuses', () => {
    const b = parseUpdatesBody(text());
    expect(b.nextOffset).toBe('1287');
    expect(b.malformed).toBe(1);
    expect(b.messages.map((m) => m.kind)).toEqual(['text', 'voice', 'image', 'reaction', 'audio']);
    expect(b.messages[0]).toMatchObject({ id: 'wamid.A', from: USER, text: 'Hello agent', timestampMs: 1736844652000 });
    expect(b.messages[1]!.media).toMatchObject({ id: 'v1', mimeType: 'audio/ogg' });
    expect(b.messages[2]).toMatchObject({ caption: 'look at this', replyTo: { id: 'wamid.Q', from: 'agent:123456789' } });
    expect(b.messages[3]!.reaction).toEqual({ messageId: 'wamid.A', emoji: '' });
    expect(b.statuses).toEqual([
      { messageId: 'wamid.OUT1', status: 'read', recipient: USER, timestampMs: 1736844660000 },
      { messageId: 'wamid.OUT2', status: 'delivered', recipient: USER, timestampMs: 1736844661000 },
    ]);
    expect(b.contacts).toEqual([{ id: USER, name: 'Alex' }]);
  });
  it('keeps a 64-bit next_offset exactly (JSON.parse would round it)', () => {
    const big = '9223372036854775806';
    expect(Number(big).toString()).not.toBe(big);
    const b = parseUpdatesBody(text('', big));
    expect(b.nextOffset).toBe(big);
    expect(isValidOffset(b.nextOffset)).toBe(true);
    expect(isValidOffset('9223372036854775808')).toBe(false); // beyond int64
    expect(compareOffsets('9223372036854775806', '9223372036854775805')).toBe(1);
  });
  it('first poll omits the offset; resuming passes the stored one unchanged; limits are clamped', () => {
    expect(planPoll(null)).toEqual({ query: 'limit=50&timeout=20', mode: 'first_live' });
    expect(planPoll('9223372036854775806').query).toBe('offset=9223372036854775806&limit=50&timeout=20');
    expect(planPoll('5', { limit: 999, timeoutSec: 99 }).query).toBe('offset=5&limit=100&timeout=25');
    expect(planPoll('5', { limit: 0, timeoutSec: -4 }).query).toBe('offset=5&limit=1&timeout=0');
    expect(planPoll('not-a-number').mode).toBe('first_live'); // a corrupt stored value never turns into offset=0 (30 days of replay)
  });
  it('a 204 keeps the current offset; a lower offset is flagged', () => {
    expect(acceptNextOffset('10', null)).toEqual({ value: '10', regressed: false });
    expect(acceptNextOffset('10', '12')).toEqual({ value: '12', regressed: false });
    expect(acceptNextOffset('10', '3')).toEqual({ value: '3', regressed: true });
    expect(acceptNextOffset(null, '3')).toEqual({ value: '3', regressed: false });
  });
});

describe('error mapping and retry policy (manual section 5)', () => {
  const body = (code: number, message = `(#${code}) x`, details?: string) => ({ error: { message, type: 'OAuthException', code, ...(details ? { error_data: { details } } : {}) } });
  it('maps the documented codes', () => {
    expect(mapError('send', 400, body(131009, 'x', 'Invalid participant format')).kind).toBe('bad_request');
    expect(mapError('send', 503, body(131016)).kind).toBe('not_accepted');
    expect(mapError('send', 403, body(131005)).kind).toBe('not_creator');
    expect(mapError('status', 403, body(131005)).message).toMatch(/not sent by the agent creator/);
    expect(mapError('send', 429, body(130429)).kind).toBe('rate_limited');
    expect(mapError('poll', 409, body(1752041)).kind).toBe('replaced_poll');
    expect(mapError('poll', 401, body(190)).kind).toBe('auth');
    expect(mapError('poll', 400, body(100)).kind).toBe('auth');
    expect(mapError('send', 400, body(100, 'text.body')).kind).toBe('bad_request');
    expect(mapError('media_get', 400, body(100)).kind).toBe('not_found');
    expect(mapError('media_download', 404, body(100)).kind).toBe('not_found');
    expect(mapError('media_upload', 400, body(131053, 'x', 'size 9 MB > 5 MB')).kind).toBe('media_rejected');
    expect(mapError('send', 500, body(2)).kind).toBe('server');
    expect(mapError('send', null, null).kind).toBe('network');
    expect(mapError('send', 500, 'not json').kind).toBe('server');
  });
  it('2xx never retried (n/a), 4xx fix, 429 back off, 503/131016 resend, 500 and timeouts on a send are UNKNOWN', () => {
    expect(retryPolicy(mapError('send', 400, body(131009)))).toBe('fail');
    expect(retryPolicy(mapError('send', 403, body(131005)))).toBe('fail');
    expect(retryPolicy(mapError('send', 429, body(130429)))).toBe('retry_backoff');
    expect(retryPolicy(mapError('send', 503, body(131016)))).toBe('retry_backoff');
    expect(retryPolicy(mapError('send', 500, body(2)))).toBe('outcome_unknown');
    expect(retryPolicy(mapError('send', null, null))).toBe('outcome_unknown');
    expect(retryPolicy({ kind: 'timeout', op: 'send', httpStatus: null, code: null, message: '' })).toBe('outcome_unknown');
    expect(retryPolicy(mapError('send', 401, body(190)))).toBe('fatal_auth');
    // Things that are safe to repeat
    expect(retryPolicy(mapError('poll', 500, body(2)))).toBe('retry_backoff');
    expect(retryPolicy(mapError('poll', 429, body(130429)))).toBe('retry_backoff');
    expect(retryPolicy(mapError('poll', 409, body(1752041)))).toBe('pause_poller');
    expect(retryPolicy(mapError('status', 503, body(131016)))).toBe('retry_backoff');
    expect(retryPolicy(mapError('media_upload', 500, body(2)))).toBe('retry_backoff');
  });
  it('backoff grows, is capped and jittered within +-20%', () => {
    const d = (a: number, r = 0.5) => backoffDelay(a, { baseMs: 1000, maxMs: 30_000 }, () => r);
    expect(d(0)).toBe(1000); expect(d(1)).toBe(2000); expect(d(3)).toBe(8000); expect(d(20)).toBe(30_000);
    expect(backoffDelay(2, {}, () => 0)).toBe(3200);
    expect(backoffDelay(2, {}, () => 1)).toBe(4800);
  });
});

describe('RateLimiter', () => {
  it('allows 12 per rolling minute and tells you how long to wait for the 13th', () => {
    let t = 0;
    const l = new RateLimiter(12, 60_000, () => t);
    for (let i = 0; i < 12; i++) { expect(l.tryAcquire()).toBe(true); t += 1000; }
    expect(l.tryAcquire()).toBe(false);
    expect(l.waitMs()).toBe(60_000 - 12_000); // first stamp was at t=0, now 12 000
    t += 48_000;
    expect(l.waitMs()).toBe(0);
    expect(l.tryAcquire()).toBe(true);
    l.penalize(5000);
    expect(l.waitMs()).toBe(5000);
    expect(l.status()).toMatchObject({ limit: 12, blockedForMs: 5000 });
  });
});

describe('text splitting', () => {
  it('leaves short text alone and splits long text at paragraph boundaries within 4096', () => {
    expect(splitText('hello')).toEqual(['hello']);
    const para = 'Gold held above the 4h support while yields eased. '.repeat(20); // ~1000 chars
    const long = Array.from({ length: 12 }, () => para).join('\n\n');
    const parts = splitText(long);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts[0]).toMatch(/\(1\/\d+\)$/);
    const joined = parts.map((p) => p.replace(/\n\n\(\d+\/\d+\)$/, '')).join(' ').replace(/\s+/g, ' ');
    expect(joined.trim()).toBe(long.replace(/\s+/g, ' ').trim());
  });
  it('splits a single enormous word and never cuts a surrogate pair', () => {
    const emoji = '\u{1F4C8}'.repeat(5000);
    const parts = splitText(emoji);
    for (const p of parts) { expect(p.length).toBeLessThanOrEqual(4096); expect(p).not.toMatch(/[\uD800-\uDBFF]$/); expect(p).not.toMatch(/^[\uDC00-\uDFFF]/); }
    expect(splitText('x'.repeat(9000)).every((p) => p.length <= 4096)).toBe(true);
  });
  it('caption limit 1024 with the overflow kept for a follow-up message', () => {
    expect(splitCaption('short')).toEqual({ caption: 'short', overflow: undefined });
    const c = splitCaption(`${'a '.repeat(700)}`);
    expect(c.caption!.length).toBeLessThanOrEqual(1024);
    expect(c.overflow).toBeTruthy();
    expect(splitCaption('')).toEqual({ caption: undefined, overflow: undefined });
  });
});

describe('OutboundQueue', () => {
  const harness = (opts: { maxQueued?: number; onFatalAuth?: (e: WaError) => void } = {}) => {
    let t = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(12, 60_000, () => t);
    const queue = new OutboundQueue({ limiter, sleep: async (ms) => { sleeps.push(ms); t += ms; await Promise.resolve(); }, rand: () => 0.5, ...opts });
    return { queue, limiter, sleeps, now: () => t };
  };
  const err = (kind: WaError['kind'], extra: Partial<WaError> = {}): SendOutcome => ({ ok: false, error: { kind, op: 'send', httpStatus: 500, code: null, message: kind, ...extra } });
  const job = (id: string, parts: (() => Promise<SendOutcome>)[], o: Partial<OutboundJob> = {}): OutboundJob => ({ id, to: USER, priority: 'normal', tradeRelated: false, parts, ...o });
  const ok = (id: string) => async (): Promise<SendOutcome> => ({ ok: true, messageId: id });

  it('sends 12 immediately and holds the 13th until the rolling window frees a slot', async () => {
    const h = harness();
    const calls: number[] = [];
    const results = await Promise.all(Array.from({ length: 13 }, (_, i) => h.queue.enqueue(job(`j${i}`, [async () => { calls.push(h.now()); return { ok: true, messageId: `w${i}` }; }]))));
    expect(results.every((r) => r.status === 'sent')).toBe(true);
    expect(calls.slice(0, 12).every((c) => c === 0)).toBe(true);
    expect(calls[12]).toBe(60_000);
    expect(h.sleeps).toEqual([60_000]);
  });
  it('sends the parts of one job strictly in order and one recipient at a time', async () => {
    const h = harness();
    const order: string[] = [];
    const slow = (name: string) => async (): Promise<SendOutcome> => { order.push(`start ${name}`); await new Promise((r) => setTimeout(r, 5)); order.push(`end ${name}`); return { ok: true, messageId: name }; };
    const a = h.queue.enqueue(job('a', [slow('a1'), slow('a2')]));
    const b = h.queue.enqueue(job('b', [slow('b1')]));
    await Promise.all([a, b]);
    expect(order).toEqual(['start a1', 'end a1', 'start a2', 'end a2', 'start b1', 'end b1']);
  });
  it('critical jobs go before normal and low ones that are still waiting', async () => {
    const h = harness();
    const order: string[] = [];
    const rec = (n: string) => async (): Promise<SendOutcome> => { order.push(n); return { ok: true, messageId: n }; };
    const first = h.queue.enqueue(job('first', [rec('first')]));
    const low = h.queue.enqueue(job('low', [rec('low')], { priority: 'low' }));
    const normal = h.queue.enqueue(job('normal', [rec('normal')]));
    const crit = h.queue.enqueue(job('crit', [rec('crit')], { priority: 'critical' }));
    await Promise.all([first, low, normal, crit]);
    expect(order).toEqual(['first', 'crit', 'normal', 'low']);
  });
  it('429 backs off and re-sends the same part; 503/131016 re-sends after backing off', async () => {
    const h = harness();
    let n = 0;
    const r = await h.queue.enqueue(job('j', [async () => {
      n++;
      if (n === 1) return err('rate_limited', { httpStatus: 429, code: 130429 });
      if (n === 2) return err('not_accepted', { httpStatus: 503, code: 131016 });
      return { ok: true, messageId: 'w' };
    }]));
    expect(r).toMatchObject({ status: 'sent', messageIds: ['w'] });
    expect(n).toBe(3);
    expect(h.sleeps.length).toBe(2);
    expect(h.sleeps[1]!).toBeGreaterThan(h.sleeps[0]!);
  });
  it('a 500 on a TRADE message is UNKNOWN and is sent exactly once; later parts are not sent', async () => {
    const h = harness();
    let n = 0, later = 0;
    const r = await h.queue.enqueue(job('t', [async () => { n++; return err('server', { code: 2 }); }, async () => { later++; return { ok: true, messageId: 'x' }; }], { tradeRelated: true }));
    expect(r.status).toBe('unknown');
    expect(n).toBe(1);
    expect(later).toBe(0);
  });
  it('a read timeout on a trade message is also unknown and never re-sent', async () => {
    const h = harness();
    let n = 0;
    const r = await h.queue.enqueue(job('t', [async () => { n++; return { ok: false, error: { kind: 'timeout', op: 'send', httpStatus: null, code: null, message: 't' } }; }], { tradeRelated: true }));
    expect(r.status).toBe('unknown');
    expect(n).toBe(1);
  });
  it('a non-trade message gets one retry after an unknown outcome, then is reported unknown', async () => {
    const h = harness();
    let n = 0;
    const r = await h.queue.enqueue(job('i', [async () => { n++; return err('server', { code: 2 }); }]));
    expect(r.status).toBe('unknown');
    expect(n).toBe(2);
  });
  it('4xx failures are not retried; auth errors raise onFatalAuth', async () => {
    let fatal: WaError | null = null;
    const h = harness({ onFatalAuth: (e) => { fatal = e; } });
    let n = 0;
    const bad = await h.queue.enqueue(job('b', [async () => { n++; return err('bad_request', { httpStatus: 400, code: 131009 }); }]));
    expect(bad.status).toBe('failed'); expect(n).toBe(1);
    const auth = await h.queue.enqueue(job('a', [async () => err('auth', { httpStatus: 401, code: 190 })]));
    expect(auth.status).toBe('failed');
    expect(fatal).toMatchObject({ kind: 'auth' });
  });
  it('gives up after repeated 429s instead of looping forever', async () => {
    const h = harness();
    let n = 0;
    const r = await h.queue.enqueue(job('j', [async () => { n++; return err('rate_limited', { httpStatus: 429, code: 130429 }); }]));
    expect(r.status).toBe('failed');
    expect(n).toBe(5);
  });
  it('replaces a queued job with the same dedupe key and sheds low priority work when full', async () => {
    const h = harness({ maxQueued: 3 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blocker = h.queue.enqueue(job('blocker', [async () => { await gate; return { ok: true, messageId: 'b' }; }]));
    const sent: string[] = [];
    const rec = (n: string) => async (): Promise<SendOutcome> => { sent.push(n); return { ok: true, messageId: n }; };
    const old = h.queue.enqueue(job('old', [rec('old')], { dedupeKey: 'alert:1' }));
    const fresh = h.queue.enqueue(job('fresh', [rec('fresh')], { dedupeKey: 'alert:1' }));
    const low = h.queue.enqueue(job('low', [rec('low')], { priority: 'low' }));
    const normal = h.queue.enqueue(job('normal', [rec('normal')]));
    const crit = h.queue.enqueue(job('crit', [rec('crit')], { priority: 'critical' }));
    expect((await old).status).toBe('dropped');
    expect((await low).status).toBe('dropped');
    release();
    await Promise.all([blocker, fresh, normal, crit]);
    expect(sent).toEqual(['crit', 'fresh', 'normal']);
  });
});
