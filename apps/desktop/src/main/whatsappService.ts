import { randomInt, randomUUID } from 'node:crypto';
import {
  WhatsAppPipeline, WhatsAppSettingsSchema, inQuietHours,
  type ActionOutcome, type FeedStatus, type NotificationChannel, type NotificationEvent, type OutboundChannel, type ProposedAction,
  type RemoteActionContext, type RemoteActionHandler, type RemoteAiHandler, type RemoteAiInput, type RemoteAiResult, type Severity, type Tick, type Transcriber,
  type WaHistoryEntry, type WhatsAppSettings,
} from '@aurum/core';
import { z } from 'zod';
import { WhatsAppGateway } from './whatsapp';
import type { SqliteWhatsAppStore } from './whatsappStore';
import type { WaAttachment, WaAiRequest, WaAiResponse, WaExecRequest, WaProposedCall, WaQuietHours, WaUiSettings, WaUiStatus } from '../whatsappShared';

/**
 * Composition root for the WhatsApp gateway: connector + pipeline + store + handlers.
 * Every external dependency is injected so the lead can connect them at merge and so it runs without Electron in tests.
 */

/** Minimal alert shape the /alerts command needs. The alerts service (another branch) provides richer objects; extra fields are ignored. */
export interface AlertView { id: string; name: string; enabled: boolean; summary?: string; state?: string }

export interface WhatsAppServiceDeps {
  store: SqliteWhatsAppStore;
  secrets: {
    secureStorageAvailable(): boolean;
    getToken(): string | null;
    setToken(token: string): void;
    clearToken(): void;
  };
  getTick(): Tick | null;
  getFeedStatus(): FeedStatus;
  /** Optional: absent until the alerts service is merged. */
  getAlerts?: () => AlertView[];
  /** Optional: absent until the alerts service is merged. The service registers its WhatsApp channel when present. */
  registerNotificationChannel?: (channel: NotificationChannel) => (() => void) | void;
  /** Sends a message to the renderer window. Returns false when there is no usable window. */
  sendToRenderer(channel: string, payload: unknown): boolean;
  /** Honoured only when set (dev and tests): AURUM_WHATSAPP_BASE_URL. */
  baseUrl?: string | undefined;
  /** Symbol label for /price. */
  symbolLabel?: () => string;
  /** Voice notes -> text (main/transcribe.ts). Absent = voice notes are declined politely. */
  transcriber?: Transcriber;
  onStatusChange?: (s: WaUiStatus) => void;
  now?: () => number;
  log?: (m: string) => void;
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const QuietSchema = z.object({
  enabled: z.boolean().default(false), start: HHMM.default('22:00'), end: HHMM.default('07:00'),
  tz: z.string().min(1).max(64).default('UTC'), allowCritical: z.boolean().default(true),
});
export const WaUiSettingsPatchSchema = z.object({
  enabled: z.boolean(), permission: z.enum(['notify', 'ask', 'chart', 'trade']), confirmChartActions: z.boolean(), notifications: z.boolean(),
  quietHours: QuietSchema.partial(),
}).partial();

const AI_TURN_TIMEOUT_MS = 110_000;
const NO_WINDOW = 'Open Aurum on the PC to use the AI.';

export class WhatsAppService {
  readonly gateway: WhatsAppGateway;
  readonly pipeline: WhatsAppPipeline;
  private readonly now: () => number;
  private aiReady = false;
  private pendingRenderer = new Map<string, (r: WaAiResponse) => void>();
  private unregisterChannel: (() => void) | null = null;
  private channelRegistered = false;
  private running = false;

  constructor(private readonly d: WhatsAppServiceDeps) {
    this.now = d.now ?? Date.now;
    this.gateway = new WhatsAppGateway({
      ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
      getToken: () => d.secrets.getToken(),
      store: d.store,
      onBatch: async (batch) => {
        const { work } = await this.pipeline.ingest(batch.messages);
        void this.pipeline.enqueueWork(work); // classification is persisted; the offset may advance while the AI works
      },
      now: this.now,
      ...(d.log ? { log: d.log } : {}),
    });
    this.pipeline = new WhatsAppPipeline({
      store: d.store,
      settings: () => this.settings(),
      actions: this.actions,
      ai: this.ai,
      now: this.now,
      randomDigits: (n) => Array.from({ length: n }, () => String(randomInt(0, 10))).join(''),
      send: this.gateway.sendReply,
      markRead: this.gateway.markRead,
      fetchMedia: this.gateway.downloadMedia,
      ...(d.transcriber ? { transcriber: d.transcriber } : {}),
      gatewayStatus: () => `WhatsApp: ${this.gateway.status().state}`,
      ...(d.log ? { log: d.log } : {}),
    });
    this.gateway.onStatus(() => this.pushStatus());
    this.registerChannel();
  }

  // ----- settings -------------------------------------------------------------------------------

  settings(): WhatsAppSettings { return this.d.store.getSettings(); }
  quietHours(): WaQuietHours {
    try { return QuietSchema.parse(JSON.parse(this.d.store.getMeta('quietHours') ?? '{}')); } catch { return QuietSchema.parse({}); }
  }
  uiSettings(): WaUiSettings {
    const s = this.settings();
    return { enabled: s.enabled, permission: s.permission, confirmChartActions: s.confirmChartActions, notifications: s.notifications, quietHours: this.quietHours() };
  }
  setUiSettings(raw: unknown): WaUiSettings {
    const p = WaUiSettingsPatchSchema.parse(raw);
    const { quietHours, ...rest } = p;
    this.d.store.setSettings(WhatsAppSettingsSchema.parse({ ...this.settings(), ...rest }));
    if (quietHours) this.d.store.setMeta('quietHours', JSON.stringify(QuietSchema.parse({ ...this.quietHours(), ...quietHours })));
    this.syncRunning();
    this.pushStatus();
    return this.uiSettings();
  }

  // ----- lifecycle ------------------------------------------------------------------------------

  /** Start according to settings: enabled + token. */
  start(): void { this.syncRunning(); }
  async stop(): Promise<void> { this.running = false; await this.gateway.stop(); this.pushStatus(); }
  private syncRunning(): void {
    const want = this.settings().enabled && !!this.d.secrets.getToken();
    if (want && !this.gateway.isRunning) { this.gateway.start(); this.running = true; }
    else if (!want && this.gateway.isRunning) { void this.gateway.stop(); this.running = false; }
    this.pushStatus();
  }
  async setRunning(on: boolean): Promise<void> {
    this.setUiSettings({ enabled: on });
    if (!on) await this.gateway.stop();
    this.pushStatus();
  }

  setToken(token: string): void {
    this.d.secrets.setToken(token);
    this.d.store.clearOffset(); // a different agent token has a different update stream
    this.syncRunning();
  }
  async clearToken(): Promise<void> {
    await this.gateway.stop();
    this.d.secrets.clearToken();
    this.d.store.clearOffset();
    this.d.store.resetLink();
    this.running = false;
    this.pushStatus();
  }
  /** Reset the link so the next message from the creator starts pairing, and make sure polling runs. */
  startPairing(): void {
    this.d.store.resetLink();
    this.setUiSettings({ enabled: true });
  }
  cancelPairing(): void { this.d.store.resetLink(); this.pushStatus(); }
  unlink(): void { this.d.store.resetLink(); this.pushStatus(); }
  async test(): Promise<{ ok: boolean; message: string }> {
    const r = await this.gateway.testConnection();
    this.pushStatus();
    return r;
  }
  history(limit = 100): WaHistoryEntry[] { return this.d.store.listHistory(limit); }

  status(): WaUiStatus {
    const g = this.gateway.status();
    const link = this.d.store.getLink();
    return {
      secureStorage: this.d.secrets.secureStorageAvailable(),
      hasToken: !!this.d.secrets.getToken(),
      running: this.gateway.isRunning,
      state: g.state,
      lastSyncAt: g.lastSyncAt, lastError: g.lastError, nextRetryAt: g.nextRetryAt,
      rate: { sendUsed: g.rate.messages.used, sendLimit: g.rate.messages.limit, queued: g.rate.queued },
      link: link.status === 'linked' ? { status: 'linked', linkedAt: link.linkedAt }
        : link.status === 'pairing' && this.now() < link.expiresAt ? { status: 'pairing', code: link.code, expiresAt: link.expiresAt, attempts: link.attempts }
        : { status: 'unlinked' },
      remotePaused: this.paused,
      aiWindowReady: this.aiReady,
      alertsChannelRegistered: this.channelRegistered,
    };
  }
  private pushStatus(): void { try { const s = this.status(); this.d.onStatusChange?.(s); this.d.sendToRenderer('wa:status:push', s); } catch { /* status push is best effort */ } }

  private get paused(): boolean { return this.d.store.getMeta('remotePaused') === '1'; }

  // ----- renderer round trip --------------------------------------------------------------------

  setAiReady(ready: boolean): void { this.aiReady = ready; this.pushStatus(); }
  handleRendererResponse(r: WaAiResponse): void {
    const cb = this.pendingRenderer.get(r.id);
    if (cb) { this.pendingRenderer.delete(r.id); cb(r); }
  }
  private askRenderer(req: WaAiRequest | WaExecRequest): Promise<WaAiResponse | null> {
    if (!this.aiReady) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pendingRenderer.delete(req.id); resolve({ id: req.id, ok: false, text: '', error: 'The Aurum window did not answer in time.' }); }, AI_TURN_TIMEOUT_MS);
      this.pendingRenderer.set(req.id, (r) => { clearTimeout(t); resolve(r); });
      if (!this.d.sendToRenderer('wa:ai:request', req)) { clearTimeout(t); this.pendingRenderer.delete(req.id); resolve(null); }
    });
  }

  readonly ai: RemoteAiHandler = {
    handle: async (input: RemoteAiInput): Promise<RemoteAiResult> => {
      if (this.paused) return { text: 'Remote AI is paused (/pause). Send /resume to re-enable it.' };
      if (input.attachments.length) { /* images are not forwarded to the headless turn yet; the text still is */ }
      const level = input.canControlChart ? 'chart' : 'ask';
      const attachments: WaAttachment[] = input.attachments.map((a) => (a.kind === 'image'
        ? { kind: 'image' as const, mime: a.mimeType, data: Buffer.from(a.bytes).toString('base64') }
        : { kind: 'document' as const, mime: a.mimeType, name: a.name, data: Buffer.from(a.bytes).toString('base64') }));
      const res = await this.askRenderer({ id: randomUUID(), text: input.text, conversationKey: input.conversationKey, level, ...(attachments.length ? { attachments } : {}) });
      if (!res) return { text: NO_WINDOW };
      if (!res.ok) throw new Error(res.error ?? 'The AI request failed.');
      const out: RemoteAiResult = { text: res.text };
      if (res.images?.length) out.images = res.images.map((im, i) => ({ bytes: new Uint8Array(Buffer.from(im.data, 'base64')), mimeType: im.mime, filename: `chart-${i + 1}.png` }));
      if (res.options && res.options.length >= 2 && level === 'chart') {
        const [first, ...rest] = res.options;
        out.proposedAction = {
          kind: 'ai_tools', payload: { calls: first!.calls }, preview: first!.preview.slice(0, 1900), level: 'chart', label: first!.label,
          alternatives: rest.map((o) => ({ kind: 'ai_tools', payload: { calls: o.calls }, preview: o.preview.slice(0, 1900), level: 'chart' as const, label: o.label })),
        };
      } else if (res.proposed && res.proposed.calls.length && level === 'chart') {
        out.proposedAction = { kind: 'ai_tools', payload: { calls: res.proposed.calls }, preview: res.proposed.preview.slice(0, 1900), level: 'chart' };
      }
      return out;
    },
  };

  readonly actions: RemoteActionHandler = {
    price: async () => {
      const feed = this.d.getFeedStatus();
      const t = this.d.getTick();
      if (!t || (feed.state !== 'connected' && feed.state !== 'stale')) return `No live price: MT5 feed is ${feed.state}${feed.message ? ` (${feed.message})` : ''}.`;
      const age = Math.max(0, Math.round(this.now() / 1000 - t.time));
      return `${this.d.symbolLabel?.() ?? t.symbol} bid ${t.bid} / ask ${t.ask} (spread ${t.spread})${feed.state === 'stale' ? ` STALE feed, last tick ${age}s ago` : ''}`;
    },
    status: async () => {
      const feed = this.d.getFeedStatus();
      const s = this.settings();
      return `MT5 feed: ${feed.state}${feed.message ? ` (${feed.message})` : ''}\nAI permission over WhatsApp: ${s.permission}${this.paused ? '\nRemote actions: PAUSED' : ''}\nAurum window for AI: ${this.aiReady ? 'open' : 'not available'}`;
    },
    positions: async () => 'Open positions are not available: order management is not connected in this build.',
    alerts: async () => {
      if (!this.d.getAlerts) return 'Alerts are not available in this build yet.';
      const list = this.d.getAlerts();
      if (!list.length) return 'No alerts.';
      return list.slice(0, 15).map((a) => `${a.enabled ? '[on]' : '[off]'} ${a.name}${a.summary ? `: ${a.summary}` : ''}${a.state ? ` (${a.state})` : ''}`).join('\n') + (list.length > 15 ? `\n...and ${list.length - 15} more` : '');
    },
    pause: async () => { this.d.store.setMeta('remotePaused', '1'); this.pushStatus(); return 'Paused. Remote AI and chart actions are off until you /resume (needs a code).'; },
    resume: async () => { this.d.store.setMeta('remotePaused', '0'); this.pushStatus(); return 'Resumed. Remote AI is on again.'; },
    executeConfirmed: async (action: ProposedAction, _ctx: RemoteActionContext): Promise<ActionOutcome> => {
      if (this.paused) return { status: 'rejected', text: 'Remote actions are paused. Nothing was done.' };
      if (action.kind !== 'ai_tools') return { status: 'failed', text: `Unsupported action "${action.kind}", nothing was done.` };
      const calls = z.array(z.object({ name: z.string(), input: z.unknown() })).safeParse((action.payload as { calls?: unknown }).calls);
      if (!calls.success) return { status: 'failed', text: 'The stored action was malformed, nothing was done.' };
      const res = await this.askRenderer({ id: randomUUID(), exec: true, calls: calls.data as WaProposedCall[] });
      if (!res) return { status: 'failed', text: NO_WINDOW + ' Nothing was done.' };
      return res.ok ? { status: 'confirmed', text: res.text } : { status: 'failed', text: res.error ?? res.text ?? 'The chart action failed.' };
    },
  };

  // ----- outbound notifications -----------------------------------------------------------------

  /** OutboundChannel (gateway) -> alerts NotificationChannel adapter. */
  notificationChannel(outbound: OutboundChannel = this.gateway): NotificationChannel {
    const prio = (s: Severity) => (s === 'critical' ? 'critical' : s === 'warning' ? 'normal' : 'low') as 'critical' | 'normal' | 'low';
    return {
      id: 'whatsapp',
      label: 'WhatsApp',
      send: async (event: NotificationEvent) => {
        const s = this.settings();
        if (!s.enabled || !s.notifications) return { status: 'suppressed', detail: 'WhatsApp notifications are turned off' };
        const q = this.quietHours();
        if (inQuietHours(q, this.now()) && !(event.severity === 'critical' && q.allowCritical)) return { status: 'suppressed', detail: `quiet hours (${q.start}-${q.end} ${q.tz})` };
        const r = await outbound.send({
          id: event.id, kind: 'alert_hit', priority: prio(event.severity), text: `${event.title}\n${event.body}`.slice(0, 8000),
          dedupeKey: `alert:${event.alertId}`, createdAt: event.at,
        });
        return r.status === 'sent' ? { status: 'sent' } : { status: r.status === 'dropped' ? 'suppressed' : 'failed', ...(r.detail ? { detail: r.detail } : {}) };
      },
    };
  }
  private registerChannel(): void {
    if (!this.d.registerNotificationChannel || this.unregisterChannel) return;
    const un = this.d.registerNotificationChannel(this.notificationChannel());
    this.unregisterChannel = typeof un === 'function' ? un : () => undefined;
    this.channelRegistered = true;
  }
}
