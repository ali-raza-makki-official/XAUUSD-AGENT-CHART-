import { z } from 'zod';

/**
 * WhatsApp Agent Platform wire format and transport rules (pure logic, no I/O).
 * Source of truth: "WhatsApp Agent Platform, Developer manual v1 (Aug 25, 2026)".
 * Nothing in this file talks to the network; the live connector lives in apps/desktop/src/main/whatsapp.ts.
 */

export const WA_BASE_URL = 'https://api.whatsapp.com/agent/v1';

export const WA_LIMITS = {
  textMax: 4096,
  captionMax: 1024,
  /** Per agent, rolling 60 s window, each method has its own counter. */
  messagesPerMin: 12,
  statusesPerMin: 12,
  mediaPerMin: 12,
  updatesPerMin: 15,
  pollLimitMax: 100,
  pollLimitDefault: 50,
  pollTimeoutMax: 25,
  typingTtlSec: 25,
  retentionDays: 30,
} as const;

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** `user:<id>`. The whole string is opaque: compare in full, never parse or show it to a WhatsApp user. */
export const ParticipantUserSchema = z.string().regex(/^user:\S+$/, 'Expected a user:<id> identifier');

// ---------------------------------------------------------------------------------------------
// POST /agent/v1/messages
// ---------------------------------------------------------------------------------------------

const Context = z.object({ message_id: z.string().min(1) }).strict();
const Caption = z.string().max(WA_LIMITS.captionMax);
const sendBase = { messaging_product: z.literal('whatsapp'), to: ParticipantUserSchema, context: Context.optional() };

export const SendRequestSchema = z.discriminatedUnion('type', [
  z.object({
    ...sendBase,
    type: z.literal('text'),
    text: z.object({ body: z.string().min(1).max(WA_LIMITS.textMax), preview_url: z.boolean().optional() }).strict(),
  }).strict(),
  z.object({ ...sendBase, type: z.literal('image'), image: z.object({ id: z.string().min(1), caption: Caption.optional() }).strict() }).strict(),
  z.object({ ...sendBase, type: z.literal('video'), video: z.object({ id: z.string().min(1), caption: Caption.optional() }).strict() }).strict(),
  z.object({
    ...sendBase,
    type: z.literal('document'),
    document: z.object({ id: z.string().min(1), caption: Caption.optional(), filename: z.string().min(1).max(255).optional() }).strict(),
  }).strict(),
  // No captions on audio or stickers.
  z.object({ ...sendBase, type: z.literal('audio'), audio: z.object({ id: z.string().min(1) }).strict() }).strict(),
  z.object({ ...sendBase, type: z.literal('sticker'), sticker: z.object({ id: z.string().min(1) }).strict() }).strict(),
]);
export type SendRequest = z.infer<typeof SendRequestSchema>;

export const SendResponseSchema = z.object({
  messaging_product: z.literal('whatsapp').optional(),
  contacts: z.array(z.object({ input: z.string().optional(), wa_id: z.string().optional() })).optional(),
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
});

export const textRequest = (to: string, body: string, replyTo?: string): SendRequest =>
  SendRequestSchema.parse({
    messaging_product: 'whatsapp', to, type: 'text', text: { body },
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
  });

export const mediaRequest = (
  to: string,
  type: 'image' | 'document',
  mediaId: string,
  opts: { caption?: string; filename?: string; replyTo?: string } = {},
): SendRequest =>
  SendRequestSchema.parse({
    messaging_product: 'whatsapp', to, type,
    [type]: { id: mediaId, ...(opts.caption ? { caption: opts.caption } : {}), ...(type === 'document' && opts.filename ? { filename: opts.filename } : {}) },
    ...(opts.replyTo ? { context: { message_id: opts.replyTo } } : {}),
  });

// ---------------------------------------------------------------------------------------------
// POST /agent/v1/statuses (read receipt + typing indicator)
// ---------------------------------------------------------------------------------------------

export const StatusRequestSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  status: z.literal('read'),
  message_id: z.string().min(1),
  typing_indicator: z.object({ type: z.literal('text') }).strict().nullable().optional(),
}).strict();
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
export const StatusResponseSchema = z.object({ success: z.literal(true) });

export const readReceiptRequest = (messageId: string, typing: boolean): StatusRequest =>
  StatusRequestSchema.parse({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) });

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

export const MediaUploadResponseSchema = z.object({ id: z.string().min(1) });
export const MediaMetaSchema = z.object({
  url: z.string().min(1),
  mime_type: z.string().optional(),
  /** HEX digest here (Base64 on the inbound message object). */
  sha256: z.string().optional(),
  file_size: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  messaging_product: z.string().optional(),
});
export type MediaMeta = z.infer<typeof MediaMetaSchema>;
export const MediaDeleteResponseSchema = z.object({ success: z.literal(true) });

const MB = 1024 * 1024;
export const OUTBOUND_MEDIA = {
  image: { mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
  sticker: { mimes: ['image/webp'], maxBytes: 500 * 1024 },
  video: { mimes: ['video/mp4', 'video/3gpp'], maxBytes: 16 * MB },
  audio: { mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/opus'], maxBytes: 16 * MB },
  document: {
    mimes: [
      'application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    maxBytes: 16 * MB,
  },
} as const;
export type OutboundMediaType = keyof typeof OUTBOUND_MEDIA;

/** Returns a human-readable problem, or null when the file is acceptable for this message type. */
export function validateOutboundMedia(type: OutboundMediaType, mimeType: string, sizeBytes: number): string | null {
  const rule = OUTBOUND_MEDIA[type];
  if (!(rule.mimes as readonly string[]).includes(mimeType)) return `${mimeType || 'Unknown type'} is not accepted for ${type} messages.`;
  if (sizeBytes <= 0) return 'The file is empty.';
  if (sizeBytes > rule.maxBytes) return `File is ${(sizeBytes / MB).toFixed(1)} MB; the limit for ${type} is ${(rule.maxBytes / MB).toFixed(rule.maxBytes < MB ? 1 : 0)} MB.`;
  return null;
}

/** Largest inbound payload we are willing to download, by kind (the platform stores at most these). */
export const INBOUND_MEDIA_MAX_BYTES: Record<string, number> = { image: 5 * MB, sticker: 500 * 1024, video: 16 * MB, audio: 16 * MB, document: 16 * MB };

// ---------------------------------------------------------------------------------------------
// SHA-256 (pure, so the renderer-safe core never needs node:crypto) and digest comparison
// ---------------------------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Bytes(input: Uint8Array | string): Uint8Array {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  h.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = (input: Uint8Array | string): string => toHex(sha256Bytes(input));

export function base64ToHex(b64: string): string | null {
  try {
    const bin = atob(b64.trim());
    return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Verify downloaded bytes. `expectedBase64` is the digest on the inbound message object (Base64),
 * `expectedHex` is the digest from GET /media/<id> (hex). Every digest that is supplied must match;
 * at least one must be supplied, otherwise the payload is rejected (we never trust unverified media).
 */
export function verifyMediaDigest(bytes: Uint8Array, expected: { base64?: string | undefined; hex?: string | undefined }): { ok: true } | { ok: false; reason: string } {
  const actual = sha256Hex(bytes);
  let checked = 0;
  if (expected.base64) {
    checked++;
    if (base64ToHex(expected.base64) !== actual) return { ok: false, reason: 'SHA-256 does not match the digest on the message.' };
  }
  if (expected.hex) {
    checked++;
    if (expected.hex.trim().toLowerCase() !== actual) return { ok: false, reason: 'SHA-256 does not match the digest from the media endpoint.' };
  }
  return checked > 0 ? { ok: true } : { ok: false, reason: 'No SHA-256 digest was supplied to verify the download.' };
}

/** Constant-time-ish string comparison for codes. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------------------------
// GET /agent/v1/updates: schemas, BigInt-safe parsing, normaliser
// ---------------------------------------------------------------------------------------------

const MediaObj = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  /** Base64 digest on inbound objects. */
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
  animated: z.boolean().optional(),
});

export const InboundMessageSchema = z.object({
  from: z.string().min(1),
  id: z.string().min(1),
  /** Unix seconds, as a string. */
  timestamp: z.string(),
  type: z.string(),
  context: z.object({ id: z.string(), from: z.string() }).optional(),
  text: z.object({ body: z.string() }).optional(),
  image: MediaObj.optional(),
  audio: MediaObj.optional(),
  video: MediaObj.optional(),
  document: MediaObj.optional(),
  sticker: MediaObj.optional(),
  reaction: z.object({ message_id: z.string(), emoji: z.string().optional() }).optional(),
});
export type InboundMessageRaw = z.infer<typeof InboundMessageSchema>;

export const StatusObjectSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  recipient_id: z.string().optional(),
  timestamp: z.string().optional(),
});

/** next_offset arrives as a JSON integer that can exceed 2^53; parseUpdatesBody turns it into a string first. */
export const OffsetStringSchema = z.string().regex(/^-?\d{1,19}$/);

export const UpdatesEnvelopeSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({
    id: z.string().optional(),
    changes: z.array(z.object({
      field: z.string().optional(),
      value: z.object({
        messaging_product: z.string().optional(),
        contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() })).default([]),
        // Parsed one by one so a single malformed message cannot drop the whole batch.
        messages: z.array(z.unknown()).default([]),
        statuses: z.array(z.unknown()).default([]),
      }),
    })),
  })).default([]),
  next_offset: OffsetStringSchema.optional(),
});

/** Quote the integer after "next_offset" so JSON.parse cannot round a 64-bit value. */
export function protectNextOffset(text: string): string {
  return text.replace(/("next_offset"\s*:\s*)(-?\d+)/, '$1"$2"');
}

export type InboundKind = 'text' | 'voice' | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'reaction' | 'unsupported';
export interface InboundMedia { id: string; mimeType: string | undefined; sha256Base64: string | undefined; filename: string | undefined; caption: string | undefined }
export interface InboundMessage {
  id: string;
  from: string;
  /** Milliseconds. NaN when the platform sent an unparseable timestamp (treated as stale by the pipeline). */
  timestampMs: number;
  kind: InboundKind;
  text: string | undefined;
  caption: string | undefined;
  media: InboundMedia | undefined;
  replyTo: { id: string; from: string } | undefined;
  reaction: { messageId: string; emoji: string } | undefined;
}
export interface DeliveryStatus { messageId: string; status: 'delivered' | 'read'; recipient: string | undefined; timestampMs: number }
export interface UpdatesBatch {
  nextOffset: string | null;
  messages: InboundMessage[];
  statuses: DeliveryStatus[];
  /** Profile names, accumulated by the caller across polls (the platform may omit them). */
  contacts: { id: string; name: string | undefined }[];
  malformed: number;
}

const mediaOf = (o: z.infer<typeof MediaObj>): InboundMedia => ({ id: o.id, mimeType: o.mime_type, sha256Base64: o.sha256, filename: o.filename, caption: o.caption });

export function normalizeMessage(raw: InboundMessageRaw): InboundMessage {
  const base = {
    id: raw.id, from: raw.from, timestampMs: /^\d+$/.test(raw.timestamp) ? Number(raw.timestamp) * 1000 : NaN,
    text: undefined, caption: undefined, media: undefined, reaction: undefined,
    replyTo: raw.context ? { id: raw.context.id, from: raw.context.from } : undefined,
  } satisfies Omit<InboundMessage, 'kind'>;
  const unsupported: InboundMessage = { ...base, kind: 'unsupported' };
  switch (raw.type) {
    case 'text':
      return raw.text ? { ...base, kind: 'text', text: raw.text.body } : unsupported;
    case 'audio':
      return raw.audio ? { ...base, kind: raw.audio.voice === true ? 'voice' : 'audio', media: mediaOf(raw.audio) } : unsupported;
    case 'image': case 'video': case 'document': case 'sticker': {
      const o = raw[raw.type];
      return o ? { ...base, kind: raw.type, media: mediaOf(o), caption: o.caption } : unsupported;
    }
    case 'reaction':
      return raw.reaction ? { ...base, kind: 'reaction', reaction: { messageId: raw.reaction.message_id, emoji: raw.reaction.emoji ?? '' } } : unsupported;
    default:
      return unsupported;
  }
}

/** Parse a 200 body of GET /updates. Throws on a body that is not an updates envelope at all. */
export function parseUpdatesBody(text: string): UpdatesBatch {
  const env = UpdatesEnvelopeSchema.parse(JSON.parse(protectNextOffset(text)));
  const out: UpdatesBatch = { nextOffset: env.next_offset ?? null, messages: [], statuses: [], contacts: [], malformed: 0 };
  for (const entry of env.entry) {
    for (const change of entry.changes) {
      for (const c of change.value.contacts) out.contacts.push({ id: c.wa_id, name: c.profile?.name });
      for (const m of change.value.messages) {
        const p = InboundMessageSchema.safeParse(m);
        if (p.success) out.messages.push(normalizeMessage(p.data)); else out.malformed++;
      }
      for (const s of change.value.statuses) {
        const p = StatusObjectSchema.safeParse(s);
        if (p.success && (p.data.status === 'delivered' || p.data.status === 'read')) {
          out.statuses.push({ messageId: p.data.id, status: p.data.status, recipient: p.data.recipient_id, timestampMs: /^\d+$/.test(p.data.timestamp ?? '') ? Number(p.data.timestamp) * 1000 : NaN });
        } else if (!p.success) out.malformed++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Offsets (64-bit signed, kept as strings; never computed by us)
// ---------------------------------------------------------------------------------------------

const INT64_MAX = 9223372036854775807n;
export const isValidOffset = (s: unknown): s is string => typeof s === 'string' && /^\d{1,19}$/.test(s) && BigInt(s) <= INT64_MAX;
export const compareOffsets = (a: string, b: string): -1 | 0 | 1 => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

export interface PollPlan {
  /** Query string without the leading '?'. */
  query: string;
  /** 'first_live': no stored offset, so omit it (head at request time, skips the backlog). 'resume': replay from the stored pointer. */
  mode: 'first_live' | 'resume';
}

/**
 * First poll rules from the manual: with no offset the platform starts at the head when the request arrives
 * (only new traffic). With a stored offset we resume exactly there, so messages that arrived while the app
 * was closed are returned (up to 30 days) and then handled by the expiry rules, never replayed as commands.
 * We never pass offset=0 automatically: that would replay 30 days of history.
 */
export function planPoll(storedOffset: string | null, opts: { limit?: number; timeoutSec?: number } = {}): PollPlan {
  const limit = Math.min(WA_LIMITS.pollLimitMax, Math.max(1, Math.floor(opts.limit ?? WA_LIMITS.pollLimitDefault)));
  const timeout = Math.min(WA_LIMITS.pollTimeoutMax, Math.max(0, Math.floor(opts.timeoutSec ?? 20)));
  const parts: string[] = [];
  if (storedOffset !== null && isValidOffset(storedOffset)) parts.push(`offset=${storedOffset}`);
  parts.push(`limit=${limit}`, `timeout=${timeout}`);
  return { query: parts.join('&'), mode: storedOffset !== null && isValidOffset(storedOffset) ? 'resume' : 'first_live' };
}

/** A 204 has no next_offset: keep the current one. A lower value than we hold is accepted (the platform owns it) but flagged. */
export function acceptNextOffset(current: string | null, next: string | null): { value: string | null; regressed: boolean } {
  if (next === null || !isValidOffset(next)) return { value: current, regressed: false };
  return { value: next, regressed: current !== null && isValidOffset(current) && compareOffsets(next, current) < 0 };
}

// ---------------------------------------------------------------------------------------------
// Errors and retry policy
// ---------------------------------------------------------------------------------------------

export type WaOp = 'send' | 'poll' | 'status' | 'media_upload' | 'media_get' | 'media_delete' | 'media_download';
export type WaErrorKind =
  | 'auth' | 'not_creator' | 'bad_request' | 'media_rejected' | 'not_found'
  | 'rate_limited' | 'not_accepted' | 'server' | 'replaced_poll' | 'network' | 'timeout' | 'unknown';

export interface WaError {
  kind: WaErrorKind;
  op: WaOp;
  /** null when no HTTP response was received (reset, DNS, timeout). */
  httpStatus: number | null;
  code: number | null;
  /** Safe, human-readable. Never contains the token. */
  message: string;
  details?: string | undefined;
  fbtraceId?: string | undefined;
}

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_data: z.object({ messaging_product: z.string().optional(), details: z.string().optional() }).optional(),
    fbtrace_id: z.string().optional(),
  }),
});

const looksLikeFieldName = (m: string | undefined) => !!m && /^[\w.[\]-]+$/.test(m);

/** Map an HTTP failure (status plus parsed body, if any) to a typed WaError. error.code wins over the HTTP status. */
export function mapError(op: WaOp, httpStatus: number | null, body: unknown): WaError {
  if (httpStatus === null) return { kind: 'network', op, httpStatus, code: null, message: 'No response from WhatsApp (network problem).' };
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  const e = parsed.success ? parsed.data.error : undefined;
  const code = e?.code ?? null;
  const details = e?.error_data?.details;
  const base = { op, httpStatus, code, details, fbtraceId: e?.fbtrace_id };
  const mk = (kind: WaErrorKind, message: string): WaError => ({ kind, message, ...base });

  if (code === 1752041 || httpStatus === 409) return mk('replaced_poll', 'Another client is polling this agent, so this poll was replaced (409).');
  if (code === 130429 || httpStatus === 429) return mk('rate_limited', 'WhatsApp rate limit reached (429). Backing off.');
  if (code === 131005 || httpStatus === 403) return mk('not_creator', op === 'status' ? 'That message was not sent by the agent creator.' : 'The recipient is not the agent creator. Re-link the chat.');
  if (code === 131016) return mk('not_accepted', 'WhatsApp did not accept the message for delivery (131016). It was not sent.');
  if (code === 131053) return mk('media_rejected', `Media rejected: ${details ?? 'over the size limit or unsupported type'}.`);
  if (code === 190 || httpStatus === 401) return mk('auth', 'The API token is missing or malformed (401). Re-enter it in Settings.');
  if (code === 100) {
    if (op === 'media_get' || op === 'media_delete' || op === 'media_download') return mk('not_found', 'The media id is unknown or expired (it may also mean the token is not valid).');
    if (op === 'send' && looksLikeFieldName(e?.message)) return mk('bad_request', `A field is too long: ${e?.message}.`);
    return mk('auth', 'The API token is not valid (400/100). Regenerate it in WhatsApp and re-enter it.');
  }
  if (code === 131009) return mk('bad_request', `WhatsApp rejected the request (131009): ${details ?? 'missing or malformed field'}.`);
  if (httpStatus === 503) return mk('not_accepted', 'WhatsApp could not accept the request (503).');
  if (httpStatus === 404) return mk('not_found', 'Not found or expired (404).');
  if (httpStatus >= 500 || code === 2) return mk('server', `WhatsApp internal error (${httpStatus}).`);
  if (httpStatus >= 400) return mk('bad_request', `WhatsApp rejected the request (${httpStatus}${code !== null ? `/${code}` : ''}).`);
  return mk('unknown', `Unexpected response (${httpStatus}).`);
}

export const timeoutError = (op: WaOp): WaError => ({ kind: 'timeout', op, httpStatus: null, code: null, message: 'WhatsApp did not answer in time.' });

export type RetryAction =
  /** Safe to try the same request again after backing off (nothing was delivered / request is idempotent). */
  | 'retry_backoff'
  /** The request may or may not have been processed. Do not blindly resend. */
  | 'outcome_unknown'
  /** Retrying unchanged fails the same way. */
  | 'fail'
  /** Token is wrong. Stop and ask the user. */
  | 'fatal_auth'
  /** Another poller replaced ours. Stop polling until the user resumes. */
  | 'pause_poller';

export function retryPolicy(err: WaError): RetryAction {
  switch (err.kind) {
    case 'auth': return 'fatal_auth';
    case 'replaced_poll': return 'pause_poller';
    case 'rate_limited': return 'retry_backoff';
    case 'not_creator': case 'bad_request': case 'media_rejected': case 'not_found': return 'fail';
    case 'not_accepted':
      // 503/131016 on a send: documented as "not sent, send again after backing off". A 503 on a receipt is also "retry it".
      if (err.op === 'send') return err.code === 131016 ? 'retry_backoff' : 'outcome_unknown';
      return 'retry_backoff';
    case 'server': case 'network': case 'timeout': case 'unknown':
      // A send that hit a 500, a reset or our own read timeout may have been delivered: unknown, never auto-retried for trade content.
      if (err.op === 'send') return 'outcome_unknown';
      return 'retry_backoff'; // polls, receipts and media calls are safe to repeat
  }
}

/** Exponential backoff with jitter. attempt starts at 0. */
export function backoffDelay(attempt: number, opts: { baseMs?: number; maxMs?: number; jitter?: number } = {}, rand: () => number = Math.random): number {
  const { baseMs = 1000, maxMs = 60_000, jitter = 0.2 } = opts;
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 - jitter + rand() * jitter * 2));
}

// ---------------------------------------------------------------------------------------------
// Rate limiter (rolling window)
// ---------------------------------------------------------------------------------------------

export interface RateStatus { limit: number; used: number; remaining: number; resetInMs: number; blockedForMs: number }

export class RateLimiter {
  private stamps: number[] = [];
  private blockedUntil = 0;
  constructor(readonly limit: number, readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  private prune(t: number) { while (this.stamps.length && t - this.stamps[0]! >= this.windowMs) this.stamps.shift(); }

  /** Milliseconds until a request may be made (0 = now). */
  waitMs(): number {
    const t = this.now();
    this.prune(t);
    const blocked = Math.max(0, this.blockedUntil - t);
    const full = this.stamps.length >= this.limit ? this.stamps[this.stamps.length - this.limit]! + this.windowMs - t : 0;
    return Math.max(blocked, full, 0);
  }
  /** Record a request. Always records (the caller waited for waitMs()). */
  record(): void { const t = this.now(); this.prune(t); this.stamps.push(t); }
  tryAcquire(): boolean { if (this.waitMs() > 0) return false; this.record(); return true; }
  /** After a 429: hold off for at least `ms`. */
  penalize(ms: number): void { this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms); }
  status(): RateStatus {
    const t = this.now();
    this.prune(t);
    return { limit: this.limit, used: this.stamps.length, remaining: Math.max(0, this.limit - this.stamps.length), resetInMs: this.stamps.length ? this.stamps[0]! + this.windowMs - t : 0, blockedForMs: Math.max(0, this.blockedUntil - t) };
  }
}

// ---------------------------------------------------------------------------------------------
// Text splitting and captions
// ---------------------------------------------------------------------------------------------

const PART_MARKER_RESERVE = 12; // "\n\n(12/12)"

/** Split on paragraph, then line, then space boundaries; never exceeds `max` UTF-16 units and never cuts a surrogate pair. */
export function splitText(text: string, max: number = WA_LIMITS.textMax): string[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length === 0) return [];
  if (t.length <= max) return [t];
  const limit = max - PART_MARKER_RESERVE;
  const parts: string[] = [];
  let rest = t;
  while (rest.length > limit) {
    let cut = limit;
    const window = rest.slice(0, limit + 1);
    const para = window.lastIndexOf('\n\n');
    const line = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    if (para > limit * 0.4) cut = para;
    else if (line > limit * 0.4) cut = line;
    else if (space > limit * 0.4) cut = space;
    else if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? '')) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) parts.push(rest);
  return parts.map((p, i) => `${p}\n\n(${i + 1}/${parts.length})`);
}

/** Caption for a media message (limit 1024). Any overflow is returned so the caller can send it as a follow-up text. */
export function splitCaption(text: string): { caption: string | undefined; overflow: string | undefined } {
  const t = text.trim();
  if (!t) return { caption: undefined, overflow: undefined };
  if (t.length <= WA_LIMITS.captionMax) return { caption: t, overflow: undefined };
  const cutAt = t.lastIndexOf('\n', WA_LIMITS.captionMax - 1);
  const spaceAt = t.lastIndexOf(' ', WA_LIMITS.captionMax - 1);
  const cut = cutAt > 200 ? cutAt : spaceAt > 200 ? spaceAt : WA_LIMITS.captionMax;
  return { caption: t.slice(0, cut).trimEnd(), overflow: t.slice(cut).trim() || undefined };
}

// ---------------------------------------------------------------------------------------------
// Outbound queue: global 12/min, one recipient lane at a time, priorities, de-dupe, honest retry
// ---------------------------------------------------------------------------------------------

export type SendOutcome = { ok: true; messageId: string } | { ok: false; error: WaError };
export type QueuePriority = 'critical' | 'normal' | 'low';
const PRIORITY_RANK: Record<QueuePriority, number> = { critical: 0, normal: 1, low: 2 };

export interface OutboundJob {
  id: string;
  to: string;
  priority: QueuePriority;
  /** Trade-related content is never re-sent after an unknown outcome (500, reset, read timeout). */
  tradeRelated: boolean;
  /** Parts are sent strictly in order (text chunks, media then follow-up text). A part may build its request lazily (media upload). */
  parts: (() => Promise<SendOutcome>)[];
  dedupeKey?: string | undefined;
}
export type JobStatus = 'sent' | 'failed' | 'unknown' | 'dropped';
export interface JobResult {
  jobId: string;
  status: JobStatus;
  messageIds: string[];
  partsSent: number;
  partsTotal: number;
  error?: WaError;
  reason?: string;
}

export interface QueueOptions {
  limiter: RateLimiter;
  maxQueued?: number;
  maxAttempts?: number;
  /** Retries after an unknown outcome for non-trade jobs. A duplicate is possible; trade jobs never get one. */
  unknownRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  onFatalAuth?: (e: WaError) => void;
  onError?: (e: WaError, job: OutboundJob) => void;
}

interface Queued { job: OutboundJob; resolve: (r: JobResult) => void; seq: number }

export class OutboundQueue {
  private lanes = new Map<string, { running: boolean; items: Queued[] }>();
  private seq = 0;
  private readonly o: Required<Omit<QueueOptions, 'onFatalAuth' | 'onError' | 'limiter'>> & Pick<QueueOptions, 'onFatalAuth' | 'onError' | 'limiter'>;
  constructor(opts: QueueOptions) {
    this.o = {
      maxQueued: 50, maxAttempts: 5, unknownRetries: 1, rand: Math.random,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  get queued(): number { let n = 0; for (const l of this.lanes.values()) n += l.items.length; return n; }

  enqueue(job: OutboundJob): Promise<JobResult> {
    const drop = (reason: string): JobResult => ({ jobId: job.id, status: 'dropped', messageIds: [], partsSent: 0, partsTotal: job.parts.length, reason });
    if (job.parts.length === 0) return Promise.resolve(drop('Nothing to send.'));
    return new Promise<JobResult>((resolve) => {
      const lane = this.lanes.get(job.to) ?? { running: false, items: [] };
      this.lanes.set(job.to, lane);
      // A newer queued job with the same key replaces the older one (not yet started).
      if (job.dedupeKey) {
        const i = lane.items.findIndex((q) => q.job.dedupeKey === job.dedupeKey);
        if (i >= 0) lane.items.splice(i, 1)[0]!.resolve(drop('Replaced by a newer message with the same key.'));
      }
      // Flood control: when full, shed the oldest low-priority job, then refuse non-critical work.
      if (this.queued >= this.o.maxQueued) {
        const victim = this.findOldest('low');
        if (victim) victim.resolve(drop('Queue full: dropped to make room.'));
        else if (job.priority !== 'critical') { resolve(drop('Queue full.')); return; }
      }
      lane.items.push({ job, resolve, seq: this.seq++ });
      if (!lane.running) void this.runLane(job.to);
    });
  }

  private findOldest(priority: QueuePriority): Queued | undefined {
    for (const lane of this.lanes.values()) {
      const i = lane.items.findIndex((q) => q.job.priority === priority);
      if (i >= 0) return lane.items.splice(i, 1)[0];
    }
    return undefined;
  }

  private async runLane(to: string): Promise<void> {
    const lane = this.lanes.get(to)!;
    lane.running = true;
    try {
      while (lane.items.length) {
        lane.items.sort((a, b) => PRIORITY_RANK[a.job.priority] - PRIORITY_RANK[b.job.priority] || a.seq - b.seq);
        const next = lane.items.shift()!;
        let result: JobResult;
        try { result = await this.runJob(next.job); }
        catch (e) { result = { jobId: next.job.id, status: 'failed', messageIds: [], partsSent: 0, partsTotal: next.job.parts.length, reason: e instanceof Error ? e.message : String(e) }; }
        next.resolve(result);
      }
    } finally {
      lane.running = false;
      if (!lane.items.length) this.lanes.delete(to);
    }
  }

  private async waitForSlot(): Promise<void> {
    for (let w = this.o.limiter.waitMs(); w > 0; w = this.o.limiter.waitMs()) await this.o.sleep(w);
  }

  private async runJob(job: OutboundJob): Promise<JobResult> {
    const ids: string[] = [];
    const res = (status: JobStatus, extra: Partial<JobResult> = {}): JobResult => ({ jobId: job.id, status, messageIds: ids, partsSent: ids.length, partsTotal: job.parts.length, ...extra });
    for (const part of job.parts) {
      let attempt = 0;
      let unknownRetries = 0;
      for (;;) {
        await this.waitForSlot();
        this.o.limiter.record();
        const out = await part();
        if (out.ok) { ids.push(out.messageId); break; }
        const err = out.error;
        this.o.onError?.(err, job);
        const action = retryPolicy(err);
        if (action === 'fatal_auth') { this.o.onFatalAuth?.(err); return res('failed', { error: err }); }
        if (action === 'fail' || action === 'pause_poller') return res('failed', { error: err });
        if (action === 'outcome_unknown') {
          // The message may have been delivered. Trade content: never re-send. Others: one retry, accepting a possible duplicate.
          if (job.tradeRelated || unknownRetries >= this.o.unknownRetries) return res('unknown', { error: err, reason: 'Delivery unconfirmed; not re-sent automatically.' });
          unknownRetries++;
        } else if (attempt + 1 >= this.o.maxAttempts) {
          return res('failed', { error: err, reason: 'Gave up after repeated failures.' });
        }
        const delay = backoffDelay(attempt++, {}, this.o.rand);
        if (err.kind === 'rate_limited') this.o.limiter.penalize(delay);
        await this.o.sleep(delay);
      }
    }
    return res('sent');
  }
}
