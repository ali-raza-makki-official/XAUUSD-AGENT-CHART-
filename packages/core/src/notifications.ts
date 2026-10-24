import { z } from 'zod';
import { SeveritySchema, type Severity } from './alerts';
import { isValidTimeZone, localParts, parseHHMM } from './timezone';

/**
 * Notification interface. Alerts produce NotificationEvents; channels deliver them. A channel (desktop here, WhatsApp in the
 * gateway worker) registers itself in a NotificationRegistry, so adding one never touches alert code.
 */

export const NotificationEventSchema = z.object({
  id: z.string().min(1),
  alertId: z.string().min(1),
  title: z.string().max(200),
  body: z.string().max(4000),
  severity: SeveritySchema,
  /** Unix ms. */
  at: z.number(),
  /**
   * Free-form details. Alerts always put `channels: {desktop, whatsapp, sound}` here (what the alert asked for),
   * plus `reason`, `values`, `condition` and `alertName`.
   */
  data: z.record(z.string(), z.unknown()),
});
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

export interface DeliveryResult {
  status: 'sent' | 'suppressed' | 'failed';
  detail?: string;
}

export interface NotificationChannel {
  /** Stable id. The alert's channel flag with the same name ('desktop', 'whatsapp') selects this channel. */
  readonly id: string;
  readonly label: string;
  /** Optional override of the default routing (`event.data.channels[id] === true`). */
  accepts?(event: NotificationEvent): boolean;
  send(event: NotificationEvent): Promise<DeliveryResult> | DeliveryResult;
}

export interface Delivery extends DeliveryResult { channel: string; at: number }
export interface NotificationLogEntry { event: NotificationEvent; deliveries: Delivery[] }

export class NotificationRegistry {
  private channels = new Map<string, NotificationChannel>();
  /** Registers (or replaces) a channel. Returns an unregister function. */
  register(channel: NotificationChannel): () => void {
    this.channels.set(channel.id, channel);
    return () => { if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id); };
  }
  get(id: string): NotificationChannel | undefined { return this.channels.get(id); }
  list(): NotificationChannel[] { return [...this.channels.values()]; }
}

/** In-app notification log: every event with what each channel did with it (including suppressed ones). */
export class NotificationLog {
  private entries: NotificationLogEntry[] = [];
  private listeners = new Set<(e: NotificationLogEntry) => void>();
  constructor(private readonly max = 500) {}
  load(entries: NotificationLogEntry[]): void { this.entries = entries.slice(-this.max); }
  add(entry: NotificationLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.notify(entry);
  }
  addDelivery(eventId: string, delivery: Delivery): void {
    const entry = this.entries.find((e) => e.event.id === eventId);
    if (!entry) return;
    entry.deliveries.push(delivery);
    this.notify(entry);
  }
  /** Newest first. */
  recent(limit = 50): NotificationLogEntry[] { return this.entries.slice(-limit).reverse(); }
  subscribe(fn: (e: NotificationLogEntry) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify(e: NotificationLogEntry) { this.listeners.forEach((l) => l(e)); }
}

/** Logs the event, then offers it to every channel the alert asked for. A failing channel never blocks the others. */
export class NotificationRouter {
  constructor(readonly registry: NotificationRegistry, readonly log: NotificationLog, private readonly now: () => number = Date.now) {}

  async dispatch(event: NotificationEvent): Promise<NotificationLogEntry> {
    const entry: NotificationLogEntry = { event, deliveries: [] };
    this.log.add(entry);
    const wanted = (event.data.channels ?? {}) as Record<string, unknown>;
    await Promise.all(this.registry.list().map(async (ch) => {
      const want = ch.accepts ? ch.accepts(event) : wanted[ch.id] === true;
      if (!want) return;
      let result: DeliveryResult;
      try { result = await ch.send(event); }
      catch (e) { result = { status: 'failed', detail: e instanceof Error ? e.message : String(e) }; }
      this.log.addDelivery(event.id, { channel: ch.id, at: this.now(), ...result });
    }));
    return entry;
  }
}

// ---------- policy (quiet hours, per-severity, throttle, dedupe) ----------

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const NotificationSettingsSchema = z.object({
  desktopEnabled: z.boolean().default(true),
  severities: z.object({ info: z.boolean().default(true), warning: z.boolean().default(true), critical: z.boolean().default(true) }).default({ info: true, warning: true, critical: true }),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    start: HHMM.default('22:00'),
    end: HHMM.default('07:00'),
    tz: z.string().refine(isValidTimeZone, 'Unknown IANA time zone').default('UTC'),
    /** Critical alerts still come through during quiet hours. */
    allowCritical: z.boolean().default(true),
  }).default({ enabled: false, start: '22:00', end: '07:00', tz: 'UTC', allowCritical: true }),
  /** At most `max` desktop notifications per `windowSec`; the rest are logged as suppressed. Critical ones are exempt. */
  throttle: z.object({ max: z.number().int().min(1).max(100).default(6), windowSec: z.number().int().min(1).max(3600).default(60) }).default({ max: 6, windowSec: 60 }),
  /** Identical title+body for the same alert inside this window is dropped. */
  dedupeSec: z.number().int().min(0).max(3600).default(30),
  /** Master switch for the OS notification sound; an alert's own sound flag must also be on. */
  sound: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = NotificationSettingsSchema.parse({});

export function inQuietHours(q: NotificationSettings['quietHours'], nowMs: number): boolean {
  if (!q.enabled) return false;
  const p = localParts(nowMs, q.tz);
  const cur = p.hh * 60 + p.mm;
  const a = parseHHMM(q.start); const b = parseHHMM(q.end);
  const start = a.hh * 60 + a.mm; const end = b.hh * 60 + b.mm;
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Reusable by any channel that wants the same rules (the WhatsApp gateway can pass its own settings). */
export class NotificationPolicy {
  private recent: number[] = [];
  private seen = new Map<string, number>();
  constructor(private readonly getSettings: () => NotificationSettings, private readonly now: () => number = Date.now) {}

  /** Records the event as sent when allowed. */
  check(event: NotificationEvent): { allow: true } | { allow: false; reason: string } {
    const s = this.getSettings();
    const t = this.now();
    const sev: Severity = event.severity;
    if (!s.severities[sev]) return { allow: false, reason: `${sev} notifications are turned off` };
    if (inQuietHours(s.quietHours, t) && !(sev === 'critical' && s.quietHours.allowCritical)) {
      return { allow: false, reason: `quiet hours (${s.quietHours.start}-${s.quietHours.end} ${s.quietHours.tz})` };
    }
    const key = `${event.alertId}|${event.title}|${event.body}`;
    const prev = this.seen.get(key);
    if (s.dedupeSec > 0 && prev !== undefined && t - prev < s.dedupeSec * 1000) return { allow: false, reason: 'duplicate of a recent notification' };
    const windowMs = s.throttle.windowSec * 1000;
    this.recent = this.recent.filter((x) => t - x < windowMs);
    if (sev !== 'critical' && this.recent.length >= s.throttle.max) {
      return { allow: false, reason: `throttled (more than ${s.throttle.max} per ${s.throttle.windowSec}s)` };
    }
    this.recent.push(t);
    this.seen.set(key, t);
    if (this.seen.size > 500) for (const [k, v] of this.seen) if (t - v > 3_600_000) this.seen.delete(k);
    return { allow: true };
  }
}

/** Desktop channel. The actual OS toast is injected (`show`), so this stays testable and Electron lives in the main process only. */
export class DesktopChannel implements NotificationChannel {
  readonly id = 'desktop';
  readonly label = 'Desktop notification';
  private readonly policy: NotificationPolicy;
  constructor(
    private readonly show: (event: NotificationEvent, opts: { silent: boolean }) => void,
    private readonly getSettings: () => NotificationSettings,
    now: () => number = Date.now,
  ) {
    this.policy = new NotificationPolicy(getSettings, now);
  }
  send(event: NotificationEvent): DeliveryResult {
    const s = this.getSettings();
    if (!s.desktopEnabled) return { status: 'suppressed', detail: 'desktop notifications are turned off' };
    const verdict = this.policy.check(event);
    if (!verdict.allow) return { status: 'suppressed', detail: verdict.reason };
    const ch = (event.data.channels ?? {}) as { sound?: boolean };
    this.show(event, { silent: !(s.sound && ch.sound === true) });
    return { status: 'sent' };
  }
}
