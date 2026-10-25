import { z } from 'zod';
import { formatForWhatsApp } from './whatsappFormat';
import { CommandEnvelopeSchema, isExpired, type CommandEnvelope } from './command';
import { safeEqual, sha256Hex, type InboundMessage, type JobResult, type QueuePriority } from './whatsapp';

/**
 * Inbound WhatsApp command pipeline (pure; all I/O through injected interfaces).
 *
 *   message -> de-dupe (persisted) -> expiry -> identity -> permission level -> slash / AI / confirmation
 *           -> RemoteActionHandler / RemoteAiHandler (lead wires these into the central command bus) -> history
 *
 * Rules enforced here, not in the handlers:
 *  - only the linked creator (`user:<id>`, treated as an opaque conversation key) can issue commands;
 *  - a message id is processed at most once, ever (persisted), and stale messages never execute;
 *  - state-changing actions need a one-time `CONFIRM <code>` bound to the exact preview and command id.
 */

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export const WaPermissionLevelSchema = z.enum(['notify', 'ask', 'chart', 'trade']);
export type WaPermissionLevel = z.infer<typeof WaPermissionLevelSchema>;
export const WA_LEVEL_RANK: Record<WaPermissionLevel, number> = { notify: 0, ask: 1, chart: 2, trade: 3 };
export const WA_LEVEL_LABEL: Record<WaPermissionLevel, string> = {
  notify: 'Notify only: alerts come out, commands are ignored',
  ask: 'Ask AI: price, status, analysis (read-only)',
  chart: 'Chart control: AI may propose drawings and alerts',
  trade: 'Trade actions: SL/TP, close, partial (always needs a code)',
};

export const WhatsAppSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  permission: WaPermissionLevelSchema.default('ask'),
  /** Messages older than this are never acted on (default 60 s). */
  maxMessageAgeSec: z.number().int().min(10).max(600).default(60),
  confirmTtlSec: z.number().int().min(30).max(300).default(120),
  /** Chart-level proposals also need a code. Trade-level always does, regardless of this setting. */
  confirmChartActions: z.boolean().default(true),
  /** After a restart, send one summary of messages that were not acted on instead of replaying them. */
  summariseBacklog: z.boolean().default(true),
  /** Send alerts and notifications to WhatsApp. */
  notifications: z.boolean().default(true),
  /** Tell me on WhatsApp when Aurum starts or closes and when the MT5 connection drops or comes back. */
  statusNotices: z.boolean().default(true),
});
export type WhatsAppSettings = z.infer<typeof WhatsAppSettingsSchema>;
export const DEFAULT_WHATSAPP_SETTINGS: WhatsAppSettings = WhatsAppSettingsSchema.parse({});

// ---------------------------------------------------------------------------------------------
// Interfaces the lead wires
// ---------------------------------------------------------------------------------------------

export interface RemoteActionContext {
  commandId: string;
  origin: 'whatsapp';
  actor: 'whatsapp';
  /** Message timestamp (ms). */
  receivedAt: number;
}

/** An action the AI (or a slash command) wants to perform. Executed only after `CONFIRM <code>`. */
const ActionCore = z.object({
  kind: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
  /** The exact text the user sees. The code is bound to it. */
  preview: z.string().min(1).max(2000),
  level: z.enum(['chart', 'trade']),
});
/** Extra numbered choices next to the main one (option 1). The last number is always Cancel. */
export const ActionChoiceSchema = ActionCore.extend({ label: z.string().min(1).max(60) });
export type ActionChoice = z.infer<typeof ActionChoiceSchema>;
export const ProposedActionSchema = ActionCore.extend({
  /** Label of option 1 (default "Confirm"). */
  label: z.string().min(1).max(60).optional(),
  alternatives: z.array(ActionChoiceSchema).max(4).optional(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export interface ActionOutcome {
  /** 'confirmed' only after broker/command-bus confirmation. 'unknown_reconcile' means: do not retry, verify first. */
  status: 'confirmed' | 'rejected' | 'failed' | 'unknown_reconcile';
  text: string;
}

export interface RemoteActionHandler {
  price(ctx: RemoteActionContext): Promise<string>;
  status(ctx: RemoteActionContext): Promise<string>;
  positions(ctx: RemoteActionContext): Promise<string>;
  alerts(ctx: RemoteActionContext): Promise<string>;
  /** Stop AI/automated actions. Safe direction, runs without a code. */
  pause(ctx: RemoteActionContext): Promise<string>;
  /** Re-enable them. Runs only after a confirmation code. */
  resume(ctx: RemoteActionContext): Promise<string>;
  /** Run a confirmed action through the central command pipeline (commandId is the idempotency key). */
  executeConfirmed(action: ProposedAction, ctx: RemoteActionContext): Promise<ActionOutcome>;
}

export type RemoteAttachment =
  | { kind: 'image'; mimeType: string; bytes: Uint8Array }
  | { kind: 'document'; mimeType: string; bytes: Uint8Array; name: string };
export interface RemoteAiInput {
  text: string;
  attachments: RemoteAttachment[];
  commandId: string;
  messageId: string;
  /** Stable key for this WhatsApp conversation (the linked id; opaque and may change). */
  conversationKey: string;
  canControlChart: boolean;
  canProposeTrades: boolean;
  /** True when the text came from a voice note transcription. */
  viaVoice: boolean;
}
export interface RemoteAiResult {
  text: string;
  /** Anything state-changing comes back here and goes through the confirmation flow; the AI never executes it itself from WhatsApp. */
  proposedAction?: ProposedAction | undefined;
  images?: { bytes: Uint8Array; mimeType: string; filename?: string }[] | undefined;
}
export interface RemoteAiHandler { handle(input: RemoteAiInput): Promise<RemoteAiResult> }

export interface Transcriber { transcribe(audio: { bytes: Uint8Array; mimeType: string }): Promise<string> }

/** Placeholder until the lead wires the AI chat. */
export const stubAiHandler: RemoteAiHandler = { handle: async () => ({ text: 'AI not connected yet.' }) };

/** Placeholder actions: honest "not available" replies, never fabricated numbers. */
export const stubActionHandler: RemoteActionHandler = {
  price: async () => 'Live price is not available (feed handler not connected).',
  status: async () => 'Status handler not connected yet.',
  positions: async () => 'MT5 orders module not available yet.',
  alerts: async () => 'Alerts module not available yet.',
  pause: async () => 'Pause is not available yet.',
  resume: async () => 'Resume is not available yet.',
  executeConfirmed: async () => ({ status: 'failed', text: 'No action handler is connected, so nothing was done.' }),
};

// ---------------------------------------------------------------------------------------------
// Persistence contract (SQLite in the app, in-memory in tests)
// ---------------------------------------------------------------------------------------------

export type WaLinkState =
  | { status: 'unlinked' }
  | { status: 'pairing'; candidate: string; code: string; expiresAt: number; attempts: number }
  | { status: 'linked'; userId: string; linkedAt: number };

export type WaHistoryStatus =
  | 'received' | 'executed' | 'replied' | 'confirm_required' | 'confirmed' | 'cancelled'
  | 'rejected_permission' | 'rejected_identity' | 'rejected_code' | 'expired' | 'duplicate' | 'ignored'
  | 'failed' | 'unknown_outcome' | 'dropped' | 'sent' | 'delivered' | 'read' | 'pairing' | 'linked' | 'missed_summary';

export interface WaHistoryEntry {
  id?: number;
  at: number;
  direction: 'in' | 'out' | 'system';
  kind: string;
  commandId: string | null;
  /** wamid of the inbound message, or of the outbound message once sent (so delivery receipts can update the row). */
  messageId: string | null;
  summary: string;
  status: WaHistoryStatus;
  detail?: string | null;
}

export interface PendingConfirmation {
  /** Same as commandId. */
  id: string;
  commandId: string;
  code: string;
  action: ProposedAction;
  userKey: string;
  binding: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  status: 'pending' | 'used' | 'expired' | 'cancelled' | 'superseded' | 'locked';
}

export interface WhatsAppStore {
  getOffset(): string | null;
  setOffset(v: string): void;
  getLink(): WaLinkState;
  setLink(s: WaLinkState): void;
  /** Atomically record a message id. Returns false when it was already seen (duplicate). */
  markSeen(messageId: string, at: number): boolean;
  addHistory(e: WaHistoryEntry): number;
  updateHistory(id: number, patch: Partial<Pick<WaHistoryEntry, 'status' | 'detail' | 'summary' | 'messageId'>>): void;
  listHistory(limit: number): WaHistoryEntry[];
  /** Delivery receipt for an outbound wamid: marks the matching history row delivered/read. */
  setDelivery(wamid: string, status: 'delivered' | 'read', at: number): boolean;
  /** The one pending confirmation (any earlier one becomes 'superseded' on save). */
  getPending(): PendingConfirmation | null;
  savePending(p: PendingConfirmation): void;
  updatePending(id: string, patch: Partial<Pick<PendingConfirmation, 'attempts' | 'status'>>): void;
  /** Atomic single use: true only for the call that moved a still-valid pending row to 'used'. */
  consumePending(id: string, now: number): boolean;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

export interface PipelineReply {
  to: string;
  text?: string;
  images?: { bytes: Uint8Array; mimeType: string; filename?: string }[];
  kind: string;
  tradeRelated: boolean;
  priority: QueuePriority;
  replyToMessageId?: string;
  commandId?: string;
}

export interface PipelineDeps {
  store: WhatsAppStore;
  settings: () => WhatsAppSettings;
  actions: RemoteActionHandler;
  ai: RemoteAiHandler;
  transcriber?: Transcriber | undefined;
  now?: () => number;
  /** n random decimal digits from a CSPRNG. */
  randomDigits: (n: number) => string;
  /** Hand a reply to the outbound queue. */
  send: (reply: PipelineReply) => Promise<JobResult>;
  /** Read receipt + typing indicator. Failures are ignored by the pipeline. */
  markRead?: (messageId: string, typing: boolean) => Promise<void>;
  /** Download and verify inbound media (SHA-256). Throws on failure. */
  fetchMedia?: (m: NonNullable<InboundMessage['media']>, kind: InboundMessage['kind']) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** One-line gateway state for /status. */
  gatewayStatus?: () => string;
  timers?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void };
  aiTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface IngestSummary { received: number; duplicates: number; expired: number; accepted: number; ignored: number }

const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;
const CONFIRM_MAX_WRONG = 3;
const FUTURE_SKEW_MS = 2 * 60_000;
const TYPING_REFRESH_MS = 20_000;
const IDENTITY_REPLY_COOLDOWN_MS = 60 * 60_000;

const CONFIRM_RE = /^confirm\s+(\d{4,8})$/i;
const CODE_RE = /^(?:code\s*:?\s*)?(\d{6})$/i;
const YES_RE = /^(y|yes|ok|okay|confirm|confirmed|sure|do it|go|go ahead|haan|han|ji|theek hai)[.!]?$/i;
const NO_RE = /^(n|no|nahi|nahin|na)[.!]?$/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const maskCodes = (s: string) => s.replace(/(confirm\s+)\d{4,8}/gi, '$1****').replace(/\b\d{6}\b/g, '******');
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};

/** Binds a confirmation code to the exact action, preview text, command id, user and code. */
export const confirmationBinding = (p: Pick<PendingConfirmation, 'commandId' | 'code' | 'action' | 'userKey'>): string =>
  sha256Hex(canonical({ c: p.commandId, k: p.code, a: p.action, u: p.userKey }));

export const commandIdFor = (messageId: string, suffix = 'msg'): string => `wa-${sha256Hex(messageId).slice(0, 24)}-${suffix}`;

/** The message as a central-pipeline command envelope (origin whatsapp, expires after the age limit). */
export function toEnvelope(m: InboundMessage, type: string, maxAgeSec: number): CommandEnvelope {
  return CommandEnvelopeSchema.parse({
    id: commandIdFor(m.id), type, origin: 'whatsapp', actor: 'whatsapp',
    createdAt: m.timestampMs, expiresAt: m.timestampMs + maxAgeSec * 1000, payload: {},
  });
}

type Classified = { fate: 'duplicate' | 'expired' | 'invalid_time' | 'accept'; m: InboundMessage };

export class WhatsAppPipeline {
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly d: PipelineDeps) { this.now = d.now ?? Date.now; }

  /** Everything queued so far has finished (tests, shutdown). */
  idle(): Promise<void> { return this.chain; }

  /**
   * Classify a polled batch (dedupe + expiry, persisted immediately) and return the work to run.
   * The caller may persist next_offset as soon as this resolves: nothing in the batch can be processed twice.
   */
  async ingest(messages: InboundMessage[]): Promise<{ summary: IngestSummary; work: () => Promise<void> }> {
    const settings = this.d.settings();
    const link = this.d.store.getLink();
    const sorted = [...messages].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    const summary: IngestSummary = { received: sorted.length, duplicates: 0, expired: 0, accepted: 0, ignored: 0 };
    const accepted: InboundMessage[] = [];
    const missed: InboundMessage[] = [];
    for (const m of sorted) {
      const c = this.classify(m, settings);
      if (c.fate === 'duplicate') { summary.duplicates++; continue; }
      if (c.fate === 'invalid_time') { summary.ignored++; this.hist({ direction: 'in', kind: m.kind, messageId: m.id, summary: 'Message with an unusable timestamp', status: 'ignored', detail: 'timestamp missing, malformed or in the future' }); continue; }
      if (c.fate === 'expired') {
        summary.expired++;
        this.hist({ direction: 'in', kind: m.kind, messageId: m.id, summary: clip(maskCodes(this.previewOf(m)), 80), status: 'expired', detail: `older than ${settings.maxMessageAgeSec}s, not acted on` });
        if (link.status === 'linked' && link.userId === m.from) missed.push(m);
        continue;
      }
      summary.accepted++;
      accepted.push(m);
    }
    const work = async () => {
      if (missed.length && settings.summariseBacklog && link.status === 'linked') await this.sendMissedSummary(link.userId, missed);
      for (const m of accepted) {
        try { await this.process(m); }
        catch (e) {
          this.d.log?.(`pipeline error: ${e instanceof Error ? e.message : String(e)}`);
          this.hist({ direction: 'system', kind: 'error', messageId: m.id, summary: 'Error while handling a message', status: 'failed', detail: e instanceof Error ? e.message : String(e) });
          await this.reply(m.from, 'Something went wrong handling that message. Nothing was executed.', 'error', { replyTo: m.id });
        }
      }
    };
    return { summary, work };
  }

  /** ingest + run to completion, serialised behind earlier batches. */
  async handleBatch(messages: InboundMessage[]): Promise<IngestSummary> {
    const { summary, work } = await this.ingest(messages);
    await this.enqueueWork(work);
    return summary;
  }

  /** Serialise work so a slow AI call never lets two messages interleave. */
  enqueueWork(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ----- classification ---------------------------------------------------------------------

  private classify(m: InboundMessage, s: WhatsAppSettings): Classified {
    if (!this.d.store.markSeen(m.id, this.now())) {
      this.hist({ direction: 'in', kind: m.kind, messageId: m.id, summary: 'Duplicate message ignored', status: 'duplicate' });
      return { fate: 'duplicate', m };
    }
    if (!Number.isFinite(m.timestampMs) || m.timestampMs > this.now() + FUTURE_SKEW_MS) return { fate: 'invalid_time', m };
    // Unparseable or old: expired. Expiry is evaluated through the shared command envelope.
    if (isExpired(toEnvelope(m, 'whatsapp.message', s.maxMessageAgeSec), this.now())) return { fate: 'expired', m };
    return { fate: 'accept', m };
  }

  private previewOf(m: InboundMessage): string {
    if (m.kind === 'text') return m.text ?? '';
    if (m.kind === 'voice') return '[voice note]';
    return `[${m.kind}]${m.caption ? ` ${m.caption}` : ''}`;
  }

  private async sendMissedSummary(to: string, missed: InboundMessage[]): Promise<void> {
    const times = missed.map((m) => m.timestampMs).filter(Number.isFinite);
    const oldest = times.length ? new Date(Math.min(...times)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown time';
    const lines = missed.slice(0, 5).map((m) => `- ${clip(maskCodes(this.previewOf(m)).replace(/\s+/g, ' '), 40)}`);
    const text =
      `Aurum was not running (or was busy) while ${missed.length} message${missed.length === 1 ? '' : 's'} arrived (oldest ${oldest}). ` +
      `I did NOT act on ${missed.length === 1 ? 'it' : 'them'}.\n${lines.join('\n')}${missed.length > 5 ? `\n...and ${missed.length - 5} more` : ''}\nSend again if still needed.`;
    await this.reply(to, text, 'missed_summary', {});
  }

  // ----- processing -------------------------------------------------------------------------

  private async process(m: InboundMessage): Promise<void> {
    const link = this.d.store.getLink();
    if (link.status !== 'linked') return this.handleUnlinked(m, link);
    if (m.from !== link.userId) return this.rejectIdentity(m);

    const s = this.d.settings();
    const commandId = commandIdFor(m.id);
    const inId = this.hist({ direction: 'in', kind: m.kind, commandId, messageId: m.id, summary: clip(maskCodes(this.previewOf(m)), 120), status: 'received' });

    if (WA_LEVEL_RANK[s.permission] < WA_LEVEL_RANK.ask) {
      this.d.store.updateHistory(inId, { status: 'rejected_permission', detail: 'notify-only mode' });
      await this.reply(m.from, 'WhatsApp is set to notify-only, so commands are ignored. Change the level in Aurum > Settings > WhatsApp.', 'rejected', { replyTo: m.id, commandId });
      return;
    }
    const done = (status: WaHistoryStatus, detail?: string) => this.d.store.updateHistory(inId, { status, detail: detail ?? null });

    switch (m.kind) {
      case 'reaction':
        return done('ignored', 'reactions are never commands');
      case 'text':
        return this.handleText(m, m.text ?? '', false, commandId, done);
      case 'voice':
      case 'audio':
        return this.handleVoice(m, commandId, done);
      case 'image':
        return this.handleImage(m, commandId, done);
      case 'document':
        return this.handleDocument(m, commandId, done);
      default:
        await this.reply(m.from, `I can't use ${m.kind === 'unsupported' ? 'that kind of message' : `a ${m.kind}`} yet. Please send text.`, 'unsupported', { replyTo: m.id, commandId });
        return done('replied', 'unsupported type');
    }
  }

  private async handleUnlinked(m: InboundMessage, link: WaLinkState): Promise<void> {
    const startPairing = async () => {
      const code = this.d.randomDigits(6);
      this.d.store.setLink({ status: 'pairing', candidate: m.from, code, expiresAt: this.now() + PAIRING_TTL_MS, attempts: 0 });
      this.hist({ direction: 'system', kind: 'pairing', messageId: m.id, summary: 'Pairing started', status: 'pairing' });
      await this.reply(m.from, 'Aurum pairing: to link this chat, reply with the 6-digit code shown in the Aurum app (Settings > WhatsApp). It expires in 5 minutes. If you did not start this, ignore it.', 'pairing', { replyTo: m.id });
    };
    if (link.status === 'unlinked') return startPairing();
    if (link.status === 'pairing') {
      if (m.from !== link.candidate || this.now() >= link.expiresAt) return startPairing();
      const code = m.kind === 'text' ? CODE_RE.exec((m.text ?? '').trim())?.[1] : undefined;
      if (!code) { await this.reply(m.from, 'Reply with the 6-digit code shown in the Aurum app to finish linking.', 'pairing', { replyTo: m.id }); return; }
      if (safeEqual(code, link.code)) {
        this.d.store.setLink({ status: 'linked', userId: m.from, linkedAt: this.now() });
        this.hist({ direction: 'system', kind: 'pairing', messageId: m.id, summary: 'Chat linked', status: 'linked' });
        await this.reply(m.from, `Linked. Permission level: ${this.d.settings().permission}. Send /help for commands.`, 'pairing', { replyTo: m.id });
        return;
      }
      const attempts = link.attempts + 1;
      if (attempts >= PAIRING_MAX_ATTEMPTS) {
        this.d.store.setLink({ status: 'unlinked' });
        this.hist({ direction: 'system', kind: 'pairing', messageId: m.id, summary: 'Pairing cancelled after wrong codes', status: 'rejected_code' });
        await this.reply(m.from, 'Too many wrong codes. Pairing cancelled. Send any message to start again.', 'pairing', { replyTo: m.id });
      } else {
        this.d.store.setLink({ ...link, attempts });
        await this.reply(m.from, `That code is not right (${PAIRING_MAX_ATTEMPTS - attempts} tries left).`, 'pairing', { replyTo: m.id });
      }
    }
  }

  private async rejectIdentity(m: InboundMessage): Promise<void> {
    this.hist({ direction: 'in', kind: m.kind, messageId: m.id, summary: 'Message from a chat that is not linked', status: 'rejected_identity', detail: 'sender id differs from the linked id' });
    const last = Number(this.d.store.getMeta('identityReplyAt') ?? 0);
    if (this.now() - last < IDENTITY_REPLY_COOLDOWN_MS) return;
    this.d.store.setMeta('identityReplyAt', String(this.now()));
    await this.reply(m.from, 'This chat is not linked to Aurum, so I did nothing. To link it, use Aurum > Settings > WhatsApp > Re-link.', 'rejected', { replyTo: m.id });
  }

  // ----- text -------------------------------------------------------------------------------

  private async handleText(m: InboundMessage, raw: string, viaVoice: boolean, commandId: string, done: (s: WaHistoryStatus, d?: string) => void, attachments: RemoteAttachment[] = []): Promise<void> {
    const text = raw.trim();
    if (!text && attachments.length === 0) return done('ignored', 'empty');
    await this.receipt(m.id);

    const confirm = CONFIRM_RE.exec(text);
    if (confirm) {
      if (viaVoice) { await this.reply(m.from, 'Confirmation codes must be typed, not spoken.', 'confirm', { replyTo: m.id, commandId }); return done('rejected_code', 'voice cannot confirm'); }
      return this.handleConfirm(m, confirm[1]!, commandId, done);
    }
    if (/^\/?cancel$/i.test(text)) return this.handleCancel(m, commandId, done);
    const waiting = this.d.store.getPending();
    const pick = waiting && /^[1-9]$/.test(text) ? Number(text) : YES_RE.test(text) ? 1 : 0;
    if (waiting && pick) {
      if (viaVoice) {
        await this.reply(m.from, 'A spoken answer cannot confirm. Type the option number.', 'confirm', { replyTo: m.id, commandId });
        return done('rejected_code', 'voice cannot confirm');
      }
      const alts = waiting.action.alternatives ?? [];
      if (pick === alts.length + 2) return this.handleCancel(m, commandId, done);
      if (pick > alts.length + 2) {
        await this.reply(m.from, `Please reply with a number from 1 to ${alts.length + 2}.`, 'confirm', { replyTo: m.id, commandId });
        return done('rejected_code', 'option out of range');
      }
      return this.handleConfirm(m, waiting.code, commandId, done, pick);
    }
    if (waiting && NO_RE.test(text)) return this.handleCancel(m, commandId, done);
    if (!waiting && /^[1-9]$/.test(text)) {
      await this.reply(m.from, 'Nothing is waiting for an answer right now (an offer lasts only a few minutes, and a number only works right after one). Ask again if you still want it.', 'confirm', { replyTo: m.id, commandId });
      return done('replied', 'number with nothing pending');
    }
    if (/^[A-Za-z0-9_-]{120,}$/.test(text)) {
      await this.reply(m.from, 'That looks like an API token or key. Never send tokens in a chat: anyone who sees this chat could use it. I did not pass it to the AI. Revoke it in the provider\'s dashboard and create a new one.', 'security', { replyTo: m.id, commandId });
      return done('rejected_code', 'token-like text blocked');
    }
    if (text.startsWith('/')) return this.handleSlash(m, text, commandId, done);
    return this.handleAi(m, text, attachments, viaVoice, commandId, done);
  }

  private ctx(m: InboundMessage, commandId: string): RemoteActionContext { return { commandId, origin: 'whatsapp', actor: 'whatsapp', receivedAt: m.timestampMs }; }

  private async handleSlash(m: InboundMessage, text: string, commandId: string, done: (s: WaHistoryStatus, d?: string) => void): Promise<void> {
    const name = /^\/([a-z_]+)/i.exec(text)?.[1]?.toLowerCase() ?? '';
    const ctx = this.ctx(m, commandId);
    const level = this.d.settings().permission;
    const run = async (fn: () => Promise<string>, kind: string) => {
      try {
        const out = await fn();
        await this.reply(m.from, out, kind, { replyTo: m.id, commandId });
        done('executed');
      } catch (e) {
        await this.reply(m.from, `/${name} failed: ${e instanceof Error ? e.message : String(e)}`, kind, { replyTo: m.id, commandId });
        done('failed', e instanceof Error ? e.message : String(e));
      }
    };
    switch (name) {
      case 'help': return run(async () => this.helpText(level), 'help');
      case 'price': return run(() => this.d.actions.price(ctx), 'price');
      case 'status': return run(async () => `${this.d.gatewayStatus?.() ?? 'WhatsApp gateway running.'}\n${await this.d.actions.status(ctx)}`, 'status');
      case 'positions': return run(() => this.d.actions.positions(ctx), 'positions');
      case 'alerts': return run(() => this.d.actions.alerts(ctx), 'alerts');
      case 'pause': return run(() => this.d.actions.pause(ctx), 'pause');
      case 'resume':
        // Re-enabling automation raises risk, so it needs the same code as any state change.
        if (WA_LEVEL_RANK[level] < WA_LEVEL_RANK.chart) {
          await this.reply(m.from, `/resume needs the "chart" permission level (currently "${level}"). Nothing was done.`, 'rejected', { replyTo: m.id, commandId });
          return done('rejected_permission');
        }
        return this.propose(m, { kind: 'resume_automation', payload: {}, preview: 'Resume AI / automated actions.', level: 'chart' }, commandId, done, true);
      default:
        await this.reply(m.from, `Unknown command /${name}. Send /help.`, 'help', { replyTo: m.id, commandId });
        return done('replied', 'unknown command');
    }
  }

  private helpText(level: WaPermissionLevel): string {
    return [
      'Aurum commands:',
      '/price  current bid/ask',
      '/status  gateway and platform status',
      '/positions  open positions',
      '/alerts  active alerts',
      '/pause  stop AI/automated actions',
      '/resume  re-enable them (needs a code)',
      '/cancel  drop a pending confirmation',
      'Anything else goes to the AI assistant.',
      `Level: ${level}. State-changing actions always ask for CONFIRM <code> first.`,
    ].join('\n');
  }

  // ----- AI ---------------------------------------------------------------------------------

  private async handleAi(m: InboundMessage, text: string, attachments: RemoteAttachment[], viaVoice: boolean, commandId: string, done: (s: WaHistoryStatus, d?: string) => void): Promise<void> {
    const s = this.d.settings();
    const timers = this.d.timers ?? { setInterval: (fn: () => void, ms: number) => setInterval(fn, ms), clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) };
    const h = timers.setInterval(() => { void this.receipt(m.id); }, TYPING_REFRESH_MS);
    let result: RemoteAiResult;
    try {
      result = await this.withTimeout(this.d.ai.handle({
        text, attachments, commandId, messageId: m.id, conversationKey: (this.d.store.getLink() as { userId?: string }).userId ?? m.from,
        canControlChart: WA_LEVEL_RANK[s.permission] >= WA_LEVEL_RANK.chart,
        canProposeTrades: WA_LEVEL_RANK[s.permission] >= WA_LEVEL_RANK.trade,
        viaVoice,
      }), this.d.aiTimeoutMs ?? 120_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const clean = msg.replace(/^(Error: )?Error invoking remote method '[^']+': (Error: )?/, '');
      await this.reply(m.from, `The assistant could not answer: ${clip(clean, 200)}`, 'ai', { replyTo: m.id, commandId });
      return done('failed', msg);
    } finally {
      timers.clearInterval(h);
    }
    await this.reply(m.from, result.text || 'No answer.', 'ai', { replyTo: m.id, commandId, ...(result.images ? { images: result.images } : {}) });
    if (result.proposedAction) return this.propose(m, result.proposedAction, commandId, done, false);
    done('replied');
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  // ----- voice and images -------------------------------------------------------------------

  private async handleVoice(m: InboundMessage, commandId: string, done: (s: WaHistoryStatus, d?: string) => void): Promise<void> {
    if (!this.d.transcriber || !this.d.fetchMedia || !m.media) {
      await this.reply(m.from, 'Voice notes are not supported yet. Please type your message.', 'voice', { replyTo: m.id, commandId });
      return done('replied', 'voice not supported');
    }
    await this.receipt(m.id);
    let said: string;
    try {
      const file = await this.d.fetchMedia(m.media, 'voice');
      said = (await this.d.transcriber.transcribe(file)).trim();
    } catch (e) {
      await this.reply(m.from, `I could not transcribe that voice note (${clip(e instanceof Error ? e.message : String(e), 120)}). Please type it.`, 'voice', { replyTo: m.id, commandId });
      return done('failed', 'transcription failed');
    }
    if (!said) { await this.reply(m.from, 'I could not hear anything in that voice note.', 'voice', { replyTo: m.id, commandId }); return done('failed', 'empty transcript'); }
    await this.reply(m.from, `Heard: "${clip(said, 300)}"`, 'voice', { replyTo: m.id, commandId });
    // Voice goes to the AI like typed text, but can never confirm an action.
    return this.handleText(m, said.startsWith('/') ? said.replace(/^\//, '') : said, true, commandId, done);
  }

  private async handleImage(m: InboundMessage, commandId: string, done: (s: WaHistoryStatus, d?: string) => void): Promise<void> {
    if (!this.d.fetchMedia || !m.media) {
      await this.reply(m.from, 'Images are not supported yet.', 'image', { replyTo: m.id, commandId });
      return done('replied', 'image not supported');
    }
    let file: { bytes: Uint8Array; mimeType: string };
    try { file = await this.d.fetchMedia(m.media, 'image'); }
    catch (e) {
      await this.reply(m.from, `I could not download that image (${clip(e instanceof Error ? e.message : String(e), 120)}).`, 'image', { replyTo: m.id, commandId });
      return done('failed', 'media download failed');
    }
    return this.handleText(m, m.caption ?? 'Here is an image.', false, commandId, done, [{ kind: 'image', mimeType: file.mimeType, bytes: file.bytes }]);
  }

  private async handleDocument(m: InboundMessage, commandId: string, done: (s: WaHistoryStatus, d?: string) => void): Promise<void> {
    if (!this.d.fetchMedia || !m.media) {
      await this.reply(m.from, 'Files are not supported yet.', 'document', { replyTo: m.id, commandId });
      return done('replied', 'document not supported');
    }
    let file: { bytes: Uint8Array; mimeType: string };
    try { file = await this.d.fetchMedia(m.media, 'document'); }
    catch (e) {
      await this.reply(m.from, `I could not download that file (${clip(e instanceof Error ? e.message : String(e), 120)}).`, 'document', { replyTo: m.id, commandId });
      return done('failed', 'media download failed');
    }
    const name = m.media.filename ?? 'file';
    return this.handleText(m, m.caption ?? `Here is a file: ${name}.`, false, commandId, done, [{ kind: 'document', mimeType: file.mimeType, bytes: file.bytes, name }]);
  }

  // ----- confirmation codes -----------------------------------------------------------------

  /** Create a pending confirmation and send the preview with the code. */
  private async propose(m: InboundMessage, action: ProposedAction, commandId: string, done: (s: WaHistoryStatus, d?: string) => void, fromSlash: boolean): Promise<void> {
    const s = this.d.settings();
    const need = action.level;
    if (WA_LEVEL_RANK[s.permission] < WA_LEVEL_RANK[need]) {
      await this.reply(m.from, `That needs the "${need}" permission level (currently "${s.permission}"). Nothing was done.`, 'rejected', { replyTo: m.id, commandId });
      return done('rejected_permission', `needs ${need}`);
    }
    const actionCommandId = commandIdFor(m.id, 'act');
    if (action.level === 'chart' && !s.confirmChartActions && !fromSlash) {
      await this.run(m, action, actionCommandId, 'executed-without-code');
      return done('executed', 'chart action, code not required by settings');
    }
    action = { ...action, alternatives: (action.alternatives ?? []).filter((a) => WA_LEVEL_RANK[s.permission] >= WA_LEVEL_RANK[a.level]) };
    const alts = action.alternatives ?? [];
    if (!alts.length) delete action.alternatives;
    const optionLines = [`1 - ${action.label ?? 'Confirm'}`, ...alts.map((a, i) => `${i + 2} - ${a.label}`), `${alts.length + 2} - Cancel`].join('\n');
    // Drawings and alerts are harmless and people answer on a phone: five minutes. Trades keep the stricter setting.
    const ttlSec = action.level === 'chart' ? Math.max(s.confirmTtlSec, 300) : s.confirmTtlSec;
    const code = this.d.randomDigits(4);
    const createdAt = this.now();
    const base = { commandId: actionCommandId, code, action, userKey: m.from };
    this.d.store.savePending({ id: actionCommandId, ...base, binding: confirmationBinding(base), createdAt, expiresAt: createdAt + ttlSec * 1000, attempts: 0, status: 'pending' });
    const mins = ttlSec >= 120 && ttlSec % 60 === 0 ? `${ttlSec / 60} minutes` : `${ttlSec} seconds`;
    await this.reply(m.from, `${action.preview}\n\nNothing has been done yet.\n\n${optionLines}\n\nReply with a number. Valid for ${mins}, one use.`, 'confirm', { replyTo: m.id, commandId: actionCommandId, tradeRelated: action.level === 'trade', priority: 'critical' });
    this.hist({ direction: 'system', kind: 'confirm', commandId: actionCommandId, messageId: m.id, summary: clip(`Confirmation required: ${action.preview}`, 160), status: 'confirm_required' });
    done('confirm_required', 'waiting for code');
  }

  /**
   * The app itself asks the linked user something (for example "zone reached: take the trade?"). It uses the same numbered,
   * single-use, expiring answer as an AI proposal. Returns false when WhatsApp is not linked or the permission level is too low.
   */
  async askLinked(action: ProposedAction, intro: string): Promise<boolean> {
    const link = this.d.store.getLink();
    if (link.status !== 'linked') return false;
    const s = this.d.settings();
    if (WA_LEVEL_RANK[s.permission] < WA_LEVEL_RANK[action.level]) return false;
    const alts = (action.alternatives ?? []).filter((a) => WA_LEVEL_RANK[s.permission] >= WA_LEVEL_RANK[a.level]);
    action = { ...action, alternatives: alts };
    if (!alts.length) delete action.alternatives;
    const actionCommandId = commandIdFor(`ask-${this.now()}-${this.d.randomDigits(4)}`, 'act');
    const code = this.d.randomDigits(4);
    const createdAt = this.now();
    const ttlSec = action.level === 'chart' ? Math.max(s.confirmTtlSec, 300) : s.confirmTtlSec;
    const base = { commandId: actionCommandId, code, action, userKey: link.userId };
    this.d.store.savePending({ id: actionCommandId, ...base, binding: confirmationBinding(base), createdAt, expiresAt: createdAt + ttlSec * 1000, attempts: 0, status: 'pending' });
    const optionLines = [`1 - ${action.label ?? 'Confirm'}`, ...alts.map((a, i) => `${i + 2} - ${a.label}`), `${alts.length + 2} - Skip`].join('\n');
    const mins = ttlSec >= 120 && ttlSec % 60 === 0 ? `${ttlSec / 60} minutes` : `${ttlSec} seconds`;
    await this.reply(link.userId, `${intro}\n\nNothing has been done yet.\n\n${optionLines}\n\nReply with a number. Valid for ${mins}, one use.`, 'confirm', { commandId: actionCommandId, tradeRelated: action.level === 'trade', priority: 'critical' });
    this.hist({ direction: 'system', kind: 'confirm', commandId: actionCommandId, messageId: null, summary: clip(`Asked: ${action.preview}`, 160), status: 'confirm_required' });
    return true;
  }

  private async handleConfirm(m: InboundMessage, code: string, commandId: string, done: (s: WaHistoryStatus, d?: string) => void, option = 1): Promise<void> {
    const store = this.d.store;
    const p = store.getPending();
    const refuse = async (text: string, detail: string) => { await this.reply(m.from, text, 'confirm', { replyTo: m.id, commandId, priority: 'critical' }); done('rejected_code', detail); };
    if (!p) return refuse('Nothing is waiting for confirmation (a code works once and lasts only a short time). Ask again if you still want it.', 'no pending confirmation');
    if (this.now() >= p.expiresAt) {
      store.updatePending(p.id, { status: 'expired' });
      return refuse('That confirmation has expired, so nothing was done. Ask again to get a new code.', 'expired');
    }
    if (p.userKey !== m.from) return refuse('That confirmation belongs to another chat. Nothing was done.', 'user mismatch');
    if (confirmationBinding(p) !== p.binding) {
      store.updatePending(p.id, { status: 'cancelled' });
      return refuse('The stored confirmation failed its integrity check and was cancelled. Nothing was done.', 'binding mismatch');
    }
    if (!safeEqual(code, p.code)) {
      const attempts = p.attempts + 1;
      if (attempts >= CONFIRM_MAX_WRONG) {
        store.updatePending(p.id, { attempts, status: 'locked' });
        return refuse('Wrong code too many times. The action was cancelled and nothing was done.', 'locked');
      }
      store.updatePending(p.id, { attempts });
      return refuse(`Wrong code. ${CONFIRM_MAX_WRONG - attempts} tries left.`, 'wrong code');
    }
    if (!store.consumePending(p.id, this.now())) return refuse('That code was already used or has expired. Nothing was done.', 'not consumable');
    this.hist({ direction: 'system', kind: 'confirm', commandId: p.commandId, messageId: m.id, summary: clip(`Confirmed: ${p.action.preview}`, 160), status: 'confirmed' });
    const alt = option > 1 ? p.action.alternatives?.[option - 2] : undefined;
    const chosen: ProposedAction = alt ? { kind: alt.kind, payload: alt.payload, preview: alt.preview, level: alt.level } : p.action;
    await this.run(m, chosen, alt ? `${p.commandId}-o${option}` : p.commandId, 'confirmed');
    done('confirmed');
  }

  private async handleCancel(m: InboundMessage, commandId: string, done: (s: WaHistoryStatus, d?: string) => void): Promise<void> {
    const p = this.d.store.getPending();
    if (p) this.d.store.updatePending(p.id, { status: 'cancelled' });
    await this.reply(m.from, p ? 'Cancelled. Nothing was done.' : 'Nothing was waiting for confirmation.', 'confirm', { replyTo: m.id, commandId });
    done(p ? 'cancelled' : 'replied');
  }

  /** Execute through the central pipeline handler; report honestly (only "confirmed" means executed). */
  private async run(m: InboundMessage, action: ProposedAction, commandId: string, _why: string): Promise<void> {
    const ctx = this.ctx(m, commandId);
    let outcome: ActionOutcome;
    try {
      outcome = action.kind === 'resume_automation'
        ? { status: 'confirmed', text: await this.d.actions.resume(ctx) }
        : await this.d.actions.executeConfirmed(action, ctx);
    } catch (e) {
      outcome = { status: 'unknown_reconcile', text: `The action may or may not have been applied (${clip(e instanceof Error ? e.message : String(e), 120)}). Do NOT repeat it; check positions first.` };
    }
    const trade = action.level === 'trade';
    const prefix = outcome.status === 'confirmed' ? '' : outcome.status === 'rejected' ? 'Rejected: ' : outcome.status === 'failed' ? 'Failed: ' : 'Unconfirmed: ';
    await this.reply(m.from, `${prefix}${outcome.text}`, 'action_result', { replyTo: m.id, commandId, tradeRelated: trade, priority: 'critical' });
    this.hist({
      direction: 'system', kind: 'action', commandId, messageId: m.id, summary: clip(action.preview, 160),
      status: outcome.status === 'confirmed' ? 'executed' : outcome.status === 'unknown_reconcile' ? 'unknown_outcome' : 'failed', detail: outcome.status,
    });
  }

  // ----- plumbing ---------------------------------------------------------------------------

  private hist(e: Omit<WaHistoryEntry, 'at' | 'commandId'> & { commandId?: string | null }): number {
    return this.d.store.addHistory({ at: this.now(), commandId: null, ...e });
  }

  private async receipt(messageId: string): Promise<void> {
    try { await this.d.markRead?.(messageId, true); } catch { /* receipts are best effort */ }
  }

  private async reply(to: string, text: string, kind: string, o: { replyTo?: string; commandId?: string; tradeRelated?: boolean; priority?: QueuePriority; images?: PipelineReply['images'] }): Promise<void> {
    const r: PipelineReply = {
      to, text: formatForWhatsApp(text), kind, tradeRelated: o.tradeRelated ?? false, priority: o.priority ?? 'normal',
      ...(o.replyTo ? { replyToMessageId: o.replyTo } : {}), ...(o.commandId ? { commandId: o.commandId } : {}), ...(o.images ? { images: o.images } : {}),
    };
    let res: JobResult | null = null;
    try { res = await this.d.send(r); } catch (e) { this.d.log?.(`send failed: ${e instanceof Error ? e.message : String(e)}`); }
    const status: WaHistoryStatus = !res ? 'failed' : res.status === 'sent' ? 'sent' : res.status === 'unknown' ? 'unknown_outcome' : res.status === 'dropped' ? 'dropped' : 'failed';
    this.hist({
      direction: 'out', kind, commandId: o.commandId ?? null, messageId: res?.messageIds[0] ?? null,
      summary: clip(maskCodes(text), 160), status, detail: res?.error?.message ?? res?.reason ?? null,
    });
  }
}

/** In-memory store for tests (same contract as the SQLite one). */
export class MemoryWhatsAppStore implements WhatsAppStore {
  offset: string | null = null;
  link: WaLinkState = { status: 'unlinked' };
  private seen = new Set<string>();
  history: WaHistoryEntry[] = [];
  private nextId = 1;
  private pending: PendingConfirmation | null = null;
  private meta = new Map<string, string>();
  getOffset() { return this.offset; }
  setOffset(v: string) { this.offset = v; }
  getLink() { return this.link; }
  setLink(s: WaLinkState) { this.link = s; }
  markSeen(id: string) { if (this.seen.has(id)) return false; this.seen.add(id); return true; }
  addHistory(e: WaHistoryEntry) { const id = this.nextId++; this.history.push({ ...e, id }); return id; }
  updateHistory(id: number, patch: Partial<Pick<WaHistoryEntry, 'status' | 'detail' | 'summary' | 'messageId'>>) { const h = this.history.find((x) => x.id === id); if (h) Object.assign(h, patch); }
  listHistory(limit: number) { return [...this.history].reverse().slice(0, limit); }
  setDelivery(wamid: string, status: 'delivered' | 'read') {
    const h = this.history.find((x) => x.direction === 'out' && x.messageId === wamid);
    if (!h) return false;
    if (h.status === 'read' || (h.status === 'delivered' && status === 'delivered')) return true;
    h.status = status;
    return true;
  }
  getPending() { return this.pending?.status === 'pending' ? this.pending : null; }
  savePending(p: PendingConfirmation) { if (this.pending?.status === 'pending') this.pending.status = 'superseded'; this.pending = { ...p }; }
  updatePending(id: string, patch: Partial<Pick<PendingConfirmation, 'attempts' | 'status'>>) { if (this.pending?.id === id) Object.assign(this.pending, patch); }
  consumePending(id: string, now: number) {
    const p = this.pending;
    if (!p || p.id !== id || p.status !== 'pending' || now >= p.expiresAt) return false;
    p.status = 'used';
    return true;
  }
  getMeta(k: string) { return this.meta.get(k) ?? null; }
  setMeta(k: string, v: string) { this.meta.set(k, v); }
}
