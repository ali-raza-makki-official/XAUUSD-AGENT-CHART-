import { randomUUID } from 'node:crypto';
import {
  INBOUND_MEDIA_MAX_BYTES, MediaDeleteResponseSchema, MediaMetaSchema, MediaUploadResponseSchema, OutboundQueue, RateLimiter, SendRequestSchema, SendResponseSchema, StatusResponseSchema,
  WA_BASE_URL, WA_LIMITS, acceptNextOffset, backoffDelay, mapError, mediaRequest, parseUpdatesBody, planPoll, readReceiptRequest, retryPolicy, splitCaption, splitText, textRequest,
  timeoutError, validateOutboundMedia, verifyMediaDigest,
  type InboundMessage, type JobResult, type OutboundChannel, type OutboundEvent, type OutboundJob, type OutboundResult, type PipelineReply,
  type RateStatus, type SendOutcome, type SendRequest, type UpdatesBatch, type WaError, type WaHistoryEntry, type WaOp, type WaLinkState, type WhatsAppStore,
} from '@aurum/core';

/**
 * Live WhatsApp Agent Platform connector (main process, no electron imports so tests can drive it against a local mock server).
 *
 * - ONE long-poll loop per agent token (GET /updates, limit 50, timeout 20 s). A 409 means another client replaced us.
 * - next_offset is stored as a string (64-bit safe) only after the batch has been classified and recorded.
 * - Sends go through an OutboundQueue (12/min, serial per recipient). A send whose outcome is unknown is never retried for trade content.
 * - The token is only ever put in the Authorization header and is scrubbed from every message we surface.
 */

export type GatewayState = 'stopped' | 'no_token' | 'connecting' | 'polling' | 'backoff' | 'conflict' | 'auth_error';

export interface GatewayStatus {
  state: GatewayState;
  /** Last successful poll (200 or 204). null until the first one. */
  lastSyncAt: number | null;
  lastError: { message: string; at: number; kind: string } | null;
  consecutiveErrors: number;
  nextRetryAt: number | null;
  rate: { messages: RateStatus; statuses: RateStatus; updates: RateStatus; queued: number };
  /** The platform said our poll was replaced by another client (409). Polling is paused until resumed. */
  conflict: boolean;
}

export interface GatewayOptions {
  /** Defaults to the documented base URL. Tests and dev can point it at a loopback server. */
  baseUrl?: string;
  getToken: () => string | null;
  store: WhatsAppStore;
  /** Called with each polled batch after delivery receipts were applied. Must classify/persist before resolving (the offset advances after). */
  onBatch: (batch: UpdatesBatch) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand?: () => number;
  log?: (msg: string) => void;
  pollTimeoutSec?: number;
  /** Read timeout for sends, well above the normal send duration so ordinary delay never becomes "unknown". */
  sendTimeoutMs?: number;
  /** Requests per minute we hold ourselves to, below the platform limit, to absorb clock skew. */
  marginPerMinute?: number;
}

const loopback = (u: URL) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);

export function assertSafeBase(base: string): string {
  const u = new URL(base);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback(u))) throw new Error('WhatsApp base URL must use https (http only for localhost).');
  return base.replace(/\/+$/, '');
}

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });

type HttpResult = { ok: true; status: number; text: string } | { ok: false; error: WaError };

export class WhatsAppGateway implements OutboundChannel {
  readonly id = 'whatsapp';
  private readonly base: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number, s?: AbortSignal) => Promise<void>;
  private readonly rand: () => number;
  private readonly limits: { messages: RateLimiter; statuses: RateLimiter; updates: RateLimiter; mediaPost: RateLimiter; mediaGet: RateLimiter; mediaDelete: RateLimiter };
  readonly queue: OutboundQueue;

  private running = false;
  private ctl: AbortController | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private state: GatewayState = 'stopped';
  private lastSyncAt: number | null = null;
  private lastError: GatewayStatus['lastError'] = null;
  private consecutiveErrors = 0;
  private nextRetryAt: number | null = null;
  private conflictAt: number[] = [];
  private listeners = new Set<(s: GatewayStatus) => void>();
  private lastSyncWrite = 0;

  constructor(private readonly o: GatewayOptions) {
    this.base = assertSafeBase(o.baseUrl ?? WA_BASE_URL);
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? abortableSleep;
    this.rand = o.rand ?? Math.random;
    const m = o.marginPerMinute ?? 1;
    const lim = (n: number) => new RateLimiter(Math.max(1, n - m), 60_000, this.now);
    this.limits = {
      messages: lim(WA_LIMITS.messagesPerMin), statuses: lim(WA_LIMITS.statusesPerMin), updates: lim(WA_LIMITS.updatesPerMin),
      mediaPost: lim(WA_LIMITS.mediaPerMin), mediaGet: lim(WA_LIMITS.mediaPerMin), mediaDelete: lim(WA_LIMITS.mediaPerMin),
    };
    this.queue = new OutboundQueue({
      limiter: this.limits.messages, sleep: (ms) => this.sleep(ms), rand: this.rand,
      onFatalAuth: (e) => this.fatalAuth(e),
      onError: (e) => this.noteError(e),
    });
    const saved = Number(o.store.getMeta('lastSyncAt') ?? 0);
    if (saved > 0) this.lastSyncAt = saved;
  }

  // ----- status -----------------------------------------------------------------------------

  status(): GatewayStatus {
    return {
      state: this.state, lastSyncAt: this.lastSyncAt, lastError: this.lastError, consecutiveErrors: this.consecutiveErrors, nextRetryAt: this.nextRetryAt,
      rate: { messages: this.limits.messages.status(), statuses: this.limits.statuses.status(), updates: this.limits.updates.status(), queued: this.queue.queued },
      conflict: this.state === 'conflict',
    };
  }
  onStatus(cb: (s: GatewayStatus) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private emit() { const s = this.status(); for (const cb of this.listeners) { try { cb(s); } catch { /* listener errors never break the loop */ } } }
  private setState(s: GatewayState) { if (this.state !== s) { this.state = s; this.emit(); } }

  private scrub(text: string): string {
    const t = this.o.getToken();
    return t ? text.split(t).join('***') : text;
  }
  private noteError(e: WaError) {
    this.lastError = { message: this.scrub(e.message), at: this.now(), kind: e.kind };
    this.emit();
  }
  private markSync() {
    this.lastSyncAt = this.now();
    this.consecutiveErrors = 0;
    this.nextRetryAt = null;
    this.lastError = this.state === 'polling' || this.state === 'connecting' || this.state === 'backoff' ? null : this.lastError;
    if (this.lastSyncAt - this.lastSyncWrite > 10_000) { this.o.store.setMeta('lastSyncAt', String(this.lastSyncAt)); this.lastSyncWrite = this.lastSyncAt; }
    this.setState('polling');
    this.emit();
  }
  private fatalAuth(e: WaError) {
    this.noteError(e);
    this.running = false;
    this.ctl?.abort();
    this.setState('auth_error');
  }

  // ----- HTTP -------------------------------------------------------------------------------

  private async http(op: WaOp, method: 'GET' | 'POST' | 'DELETE', path: string, o: { json?: unknown; form?: FormData; timeoutMs: number; signal?: AbortSignal }): Promise<HttpResult> {
    const token = this.o.getToken();
    if (!token) return { ok: false, error: { kind: 'auth', op, httpStatus: null, code: null, message: 'No WhatsApp API token is saved.' } };
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    else if (o.form) body = o.form;
    const timeout = AbortSignal.timeout(o.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body, signal });
    } catch (e) {
      if (o.signal?.aborted) return { ok: false, error: { kind: 'network', op, httpStatus: null, code: null, message: 'Stopped.' } };
      if (timeout.aborted) return { ok: false, error: timeoutError(op) };
      return { ok: false, error: { ...mapError(op, null, null), message: this.scrub(`No response from WhatsApp: ${e instanceof Error ? e.message : String(e)}`) } };
    }
    let text: string;
    try { text = await res.text(); }
    catch { return { ok: false, error: o.signal?.aborted ? { kind: 'network', op, httpStatus: null, code: null, message: 'Stopped.' } : timeoutError(op) }; }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, text };
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const err = mapError(op, res.status, parsed);
    return { ok: false, error: { ...err, message: this.scrub(err.message), details: err.details ? this.scrub(err.details) : undefined } };
  }

  // ----- polling ----------------------------------------------------------------------------

  /** Start the single poll loop. Safe to call repeatedly. */
  start(): void {
    if (this.running) return;
    if (!this.o.getToken()) { this.setState('no_token'); return; }
    this.running = true;
    this.conflictAt = [];
    this.ctl = new AbortController();
    this.setState('connecting');
    this.loopDone = this.loop(this.ctl.signal).catch((e) => this.o.log?.(`poll loop crashed: ${this.scrub(e instanceof Error ? e.message : String(e))}`));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ctl?.abort();
    await this.loopDone;
    if (this.state !== 'auth_error' && this.state !== 'no_token') this.setState('stopped');
  }

  /** Resume after a 409 pause or an auth error was fixed. */
  resume(): void {
    this.conflictAt = [];
    this.consecutiveErrors = 0;
    void this.stop().then(() => this.start());
  }

  get isRunning(): boolean { return this.running; }

  private async loop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      const wait = this.limits.updates.waitMs();
      if (wait > 0) { await this.sleep(wait, signal); continue; }
      const r = await this.pollOnce(this.o.pollTimeoutSec ?? 20, signal);
      if (!this.running || signal.aborted) break;
      if (r === 'ok') continue;
      await this.handlePollFailure(r, signal);
    }
  }

  private async handlePollFailure(err: WaError, signal: AbortSignal): Promise<void> {
    this.noteError(err);
    const action = retryPolicy(err);
    if (action === 'fatal_auth') { this.fatalAuth(err); return; }
    if (action === 'pause_poller') {
      const t = this.now();
      this.conflictAt = [...this.conflictAt.filter((x) => t - x < 120_000), t];
      if (this.conflictAt.length >= 2) {
        // A second client keeps replacing us: stop instead of fighting over the stream.
        this.running = false;
        this.setState('conflict');
        return;
      }
      this.nextRetryAt = t + 10_000;
      this.setState('backoff');
      await this.sleep(10_000, signal);
      return;
    }
    this.consecutiveErrors++;
    const delay = backoffDelay(this.consecutiveErrors - 1, { baseMs: 2000, maxMs: 60_000 }, this.rand);
    if (err.kind === 'rate_limited') this.limits.updates.penalize(delay);
    this.nextRetryAt = this.now() + delay;
    this.setState('backoff');
    this.emit();
    await this.sleep(delay, signal);
  }

  /**
   * One GET /updates. Returns 'ok' or the error. 200: apply receipts, classify messages, then store next_offset.
   * 204: nothing to do, the same offset is reused.
   */
  async pollOnce(timeoutSec: number, signal?: AbortSignal): Promise<'ok' | WaError> {
    this.limits.updates.record();
    const plan = planPoll(this.o.store.getOffset(), { limit: WA_LIMITS.pollLimitDefault, timeoutSec });
    const r = await this.http('poll', 'GET', `/updates?${plan.query}`, { timeoutMs: (timeoutSec + 15) * 1000, ...(signal ? { signal } : {}) });
    if (!r.ok) return r.error;
    if (r.status === 204 || r.text.trim() === '') { this.markSync(); return 'ok'; }
    let batch: UpdatesBatch;
    try { batch = parseUpdatesBody(r.text); }
    catch { return { kind: 'unknown', op: 'poll', httpStatus: r.status, code: null, message: 'WhatsApp returned an updates body we could not read. The offset was not advanced.' }; }
    try {
      for (const s of batch.statuses) this.o.store.setDelivery(s.messageId, s.status, s.timestampMs);
      if (batch.messages.length) await this.o.onBatch(batch);
      const next = acceptNextOffset(this.o.store.getOffset(), batch.nextOffset);
      if (next.regressed) this.o.log?.('next_offset moved backwards; messages may be replayed and will be de-duplicated');
      if (next.value !== null) this.o.store.setOffset(next.value);
    } catch (e) {
      return { kind: 'unknown', op: 'poll', httpStatus: r.status, code: null, message: this.scrub(`Could not record the polled messages: ${e instanceof Error ? e.message : String(e)}`) };
    }
    this.markSync();
    return 'ok';
  }

  /** Connection test. While the loop runs it reports the loop's state (a second poll would replace the live one with a 409). */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.o.getToken()) return { ok: false, message: 'No API token saved.' };
    if (this.running) {
      return this.state === 'polling' && this.lastSyncAt
        ? { ok: true, message: `Polling is working (last sync ${new Date(this.lastSyncAt).toLocaleTimeString()}).` }
        : { ok: false, message: this.lastError?.message ?? 'Not connected yet.' };
    }
    const r = await this.pollOnce(0);
    if (r === 'ok') { this.setState('stopped'); return { ok: true, message: 'WhatsApp accepted the token.' }; }
    this.noteError(r);
    return { ok: false, message: r.message };
  }

  // ----- sending ----------------------------------------------------------------------------

  async sendRaw(req: SendRequest): Promise<SendOutcome> {
    const check = SendRequestSchema.safeParse(req);
    if (!check.success) return { ok: false, error: { kind: 'bad_request', op: 'send', httpStatus: null, code: null, message: `Invalid outbound message: ${check.error.issues[0]?.message ?? 'schema'}` } };
    const attempt = async (r: SendRequest): Promise<SendOutcome> => {
      const res = await this.http('send', 'POST', '/messages', { json: r, timeoutMs: this.o.sendTimeoutMs ?? 60_000 });
      if (!res.ok) return { ok: false, error: res.error };
      try {
        const parsed = SendResponseSchema.parse(JSON.parse(res.text));
        return { ok: true, messageId: parsed.messages[0]!.id };
      } catch {
        // 2xx but unreadable: the platform accepted it. Do not resend; report success without an id.
        return { ok: true, messageId: `unconfirmed-${randomUUID()}` };
      }
    };
    let out = await attempt(req);
    // A quote target the platform no longer knows is a 400 (not sent). Drop the quote and send once more.
    if (!out.ok && out.error.kind === 'bad_request' && req.context) {
      const { context: _ctx, ...rest } = req;
      out = await attempt(rest as SendRequest);
    }
    return out;
  }

  async uploadMedia(bytes: Uint8Array, mimeType: string, filename: string): Promise<{ ok: true; id: string } | { ok: false; error: WaError }> {
    for (;;) {
      const w = this.limits.mediaPost.waitMs();
      if (w <= 0) break;
      await this.sleep(w);
    }
    this.limits.mediaPost.record();
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mimeType);
    form.set('file', new Blob([bytes as BlobPart], { type: mimeType }), filename);
    const r = await this.http('media_upload', 'POST', '/media', { form, timeoutMs: 60_000 });
    if (!r.ok) return r;
    try { return { ok: true, id: MediaUploadResponseSchema.parse(JSON.parse(r.text)).id }; }
    catch { return { ok: false, error: { kind: 'unknown', op: 'media_upload', httpStatus: r.status, code: null, message: 'Upload response had no media id.' } }; }
  }

  private partsForReply(to: string, r: { text?: string | undefined; images?: PipelineReply['images']; replyToMessageId?: string | undefined }): { parts: OutboundJob['parts']; problem?: string } {
    const parts: OutboundJob['parts'] = [];
    let quote = r.replyToMessageId;
    const nextQuote = () => { const q = quote; quote = undefined; return q; };
    let text = r.text ?? '';
    let problem: string | undefined;
    for (const [i, img] of (r.images ?? []).entries()) {
      const bad = validateOutboundMedia('image', img.mimeType, img.bytes.byteLength);
      if (bad) { problem = bad; continue; }
      const { caption, overflow } = i === 0 ? splitCaption(text) : { caption: undefined, overflow: undefined };
      if (i === 0) text = overflow ?? '';
      const q = nextQuote();
      let mediaId: string | undefined;
      parts.push(async () => {
        if (!mediaId) {
          const up = await this.uploadMedia(img.bytes, img.mimeType, img.filename ?? (img.mimeType === 'image/png' ? 'chart.png' : 'image.jpg'));
          if (!up.ok) return { ok: false, error: up.error };
          mediaId = up.id;
        }
        return this.sendRaw(mediaRequest(to, 'image', mediaId, { ...(caption ? { caption } : {}), ...(q ? { replyTo: q } : {}) }));
      });
    }
    for (const chunk of splitText(text)) {
      const q = nextQuote();
      parts.push(() => this.sendRaw(textRequest(to, chunk, q)));
    }
    return { parts, ...(problem ? { problem } : {}) };
  }

  /** Pipeline replies. Resolves with the queue result (sent / unknown / failed / dropped). */
  sendReply = async (reply: PipelineReply): Promise<JobResult> => {
    const { parts, problem } = this.partsForReply(reply.to, reply);
    const id = randomUUID();
    if (parts.length === 0) return { jobId: id, status: 'failed', messageIds: [], partsSent: 0, partsTotal: 0, reason: problem ?? 'Nothing to send.' };
    return this.queue.enqueue({ id, to: reply.to, priority: reply.priority, tradeRelated: reply.tradeRelated, parts });
  };

  /** OutboundChannel: notifications to the linked creator. */
  async send(event: OutboundEvent): Promise<OutboundResult> {
    const link: WaLinkState = this.o.store.getLink();
    if (link.status !== 'linked') return { status: 'failed', detail: 'WhatsApp is not linked.' };
    const { parts, problem } = this.partsForReply(link.userId, { text: event.text, images: event.image ? [event.image] : [] });
    if (parts.length === 0) return { status: 'failed', detail: problem ?? 'Nothing to send.' };
    const res = await this.queue.enqueue({ id: randomUUID(), to: link.userId, priority: event.priority, tradeRelated: event.tradeRelated ?? false, parts, dedupeKey: event.dedupeKey });
    const entry: WaHistoryEntry = {
      at: this.now(), direction: 'out', kind: `notify:${event.kind}`, commandId: null, messageId: res.messageIds[0] ?? null,
      summary: event.text.slice(0, 160), status: res.status === 'sent' ? 'sent' : res.status === 'unknown' ? 'unknown_outcome' : res.status === 'dropped' ? 'dropped' : 'failed',
      detail: res.error?.message ?? res.reason ?? problem ?? null,
    };
    this.o.store.addHistory(entry);
    return res.status === 'sent' ? { status: 'sent' } : { status: res.status, detail: entry.detail ?? undefined };
  }

  /** Read receipt and optional typing indicator. Best effort: never throws, skips when the 12/min budget is tight. */
  markRead = async (messageId: string, typing: boolean): Promise<void> => {
    if (this.limits.statuses.waitMs() > 3000) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.limits.statuses.record();
      const r = await this.http('status', 'POST', '/statuses', { json: readReceiptRequest(messageId, typing), timeoutMs: 15_000 });
      if (r.ok) { StatusResponseSchema.safeParse(safeJson(r.text)); return; }
      if (retryPolicy(r.error) !== 'retry_backoff') { if (r.error.kind === 'auth') this.fatalAuth(r.error); return; }
      await this.sleep(backoffDelay(attempt, { baseMs: 500, maxMs: 4000 }, this.rand));
      if (this.limits.statuses.waitMs() > 3000) return;
    }
  };

  // ----- inbound media ----------------------------------------------------------------------

  /** Download media for an inbound message and verify its SHA-256 against the message digest and the media endpoint. */
  downloadMedia = async (media: NonNullable<InboundMessage['media']>, kind: InboundMessage['kind']): Promise<{ bytes: Uint8Array; mimeType: string }> => {
    const cap = INBOUND_MEDIA_MAX_BYTES[kind === 'voice' ? 'audio' : kind] ?? INBOUND_MEDIA_MAX_BYTES.document!;
    for (;;) { const w = this.limits.mediaGet.waitMs(); if (w <= 0) break; await this.sleep(w); }
    this.limits.mediaGet.record();
    const metaRes = await this.http('media_get', 'GET', `/media/${encodeURIComponent(media.id)}`, { timeoutMs: 20_000 });
    if (!metaRes.ok) throw new Error(metaRes.error.message);
    const meta = MediaMetaSchema.parse(JSON.parse(metaRes.text));
    if (meta.file_size !== undefined && meta.file_size > cap) throw new Error(`File is ${meta.file_size} bytes, over the ${cap} byte limit.`);
    const url = new URL(meta.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw new Error('Media URL is not https.');
    const token = this.o.getToken();
    if (!token) throw new Error('No API token.');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Media download failed (${res.status}).`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > cap) throw new Error('Media is larger than the allowed size.');
    const bytes = await readCapped(res, cap);
    const check = verifyMediaDigest(bytes, { base64: media.sha256Base64, hex: meta.sha256 });
    if (!check.ok) throw new Error(check.reason);
    void this.deleteMedia(media.id); // best effort: do not keep copies on the platform for 30 days
    return { bytes, mimeType: meta.mime_type ?? media.mimeType ?? 'application/octet-stream' };
  };

  private async deleteMedia(id: string): Promise<void> {
    if (this.limits.mediaDelete.waitMs() > 0) return;
    this.limits.mediaDelete.record();
    const r = await this.http('media_delete', 'DELETE', `/media/${encodeURIComponent(id)}`, { timeoutMs: 15_000 });
    if (r.ok) MediaDeleteResponseSchema.safeParse(safeJson(r.text));
  }
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) { const b = new Uint8Array(await res.arrayBuffer()); if (b.length > cap) throw new Error('Media is larger than the allowed size.'); return b; }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel(); throw new Error('Media is larger than the allowed size.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
