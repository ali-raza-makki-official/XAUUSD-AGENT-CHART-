import { z } from 'zod';
import { addDays, isValidTimeZone, parseHHMM, zonedParts, zonedToUtc } from './tz';

/**
 * Market sessions. Fully local: no API, no data feed. Hours are conventional defaults the user can edit;
 * DST comes from the IANA zone via Intl, so the UTC hours move by themselves when clocks change.
 * Holidays are NOT hard-coded (they cannot be verified here): the user keeps an editable closed-window list.
 */

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const Tz = z.string().refine(isValidTimeZone, 'Unknown IANA time zone');
const Instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d\d:?\d\d)$/.test(s), 'ISO-8601 with Z or offset');

export const SessionDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,24}$/),
  name: z.string().min(1).max(40),
  tz: Tz,
  open: HHMM,
  /** If close <= open the session runs past local midnight. */
  close: HHMM,
  /** Local weekdays the session runs, 0 = Sunday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).default([1, 2, 3, 4, 5]),
  enabled: z.boolean().default(true),
});
export type SessionDef = z.infer<typeof SessionDefSchema>;

/** Weekly closure in a zone, e.g. Friday 17:00 to Sunday 17:00 New York time (the usual FX/gold weekend). */
export const WeeklyClosureSchema = z.object({
  enabled: z.boolean().default(true),
  tz: Tz,
  closeDay: z.number().int().min(0).max(6),
  closeTime: HHMM,
  openDay: z.number().int().min(0).max(6),
  openTime: HHMM,
});
export type WeeklyClosure = z.infer<typeof WeeklyClosureSchema>;

export const ClosedWindowSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  /** Absolute instants with an offset or Z, e.g. 2026-12-25T00:00:00Z. */
  start: Instant,
  end: Instant,
}).refine((w) => Date.parse(w.end) > Date.parse(w.start), { message: 'end must be after start' });
export type ClosedWindow = z.infer<typeof ClosedWindowSchema>;

export const DEFAULT_SESSION_DEFS: SessionDef[] = [
  { id: 'sydney', name: 'Sydney', tz: 'Australia/Sydney', open: '07:00', close: '16:00', days: [1, 2, 3, 4, 5], enabled: true },
  { id: 'tokyo', name: 'Tokyo', tz: 'Asia/Tokyo', open: '09:00', close: '18:00', days: [1, 2, 3, 4, 5], enabled: true },
  { id: 'london', name: 'London', tz: 'Europe/London', open: '08:00', close: '17:00', days: [1, 2, 3, 4, 5], enabled: true },
  { id: 'newyork', name: 'New York', tz: 'America/New_York', open: '08:00', close: '17:00', days: [1, 2, 3, 4, 5], enabled: true },
];

export const SessionsSettingsSchema = z.object({
  sessions: z.array(SessionDefSchema).max(12).default(() => DEFAULT_SESSION_DEFS.map((s) => ({ ...s }))),
  weeklyClosure: WeeklyClosureSchema.default({ enabled: true, tz: 'America/New_York', closeDay: 5, closeTime: '17:00', openDay: 0, openTime: '17:00' }),
  closedWindows: z.array(ClosedWindowSchema).max(100).default([]),
});
export type SessionsSettings = z.infer<typeof SessionsSettingsSchema>;
export const DEFAULT_SESSIONS_SETTINGS: SessionsSettings = SessionsSettingsSchema.parse({});

export interface Interval { start: number; end: number }

/** UTC intervals in which a session is open, overlapping [from, to]. */
export function sessionIntervals(def: SessionDef, from: number, to: number): Interval[] {
  const o = parseHHMM(def.open);
  const c = parseHHMM(def.close);
  const overnight = c.h * 60 + c.mi <= o.h * 60 + o.mi;
  const a = zonedParts(from, def.tz);
  const out: Interval[] = [];
  for (let i = -2; i <= Math.ceil((to - from) / 86_400_000) + 2; i++) {
    const day = addDays(a.y, a.mo, a.d, i);
    const dow = new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay();
    if (!def.days.includes(dow)) continue;
    const start = zonedToUtc(day.y, day.mo, day.d, o.h, o.mi, def.tz);
    const endDay = overnight ? addDays(day.y, day.mo, day.d, 1) : day;
    const end = zonedToUtc(endDay.y, endDay.mo, endDay.d, c.h, c.mi, def.tz);
    if (end > from && start < to) out.push({ start, end });
  }
  return out;
}

export interface MarketStatus {
  state: 'open' | 'closed';
  reason: 'weekend' | 'closed_window' | null;
  label: string | null;
  /** Next change of state (open->closed or closed->open), UTC ms. null if none found. */
  changesAt: number | null;
}

function weeklyBoundary(w: WeeklyClosure, after: number, which: 'close' | 'open'): number | null {
  const day = which === 'close' ? w.closeDay : w.openDay;
  const t = parseHHMM(which === 'close' ? w.closeTime : w.openTime);
  const a = zonedParts(after, w.tz);
  for (let i = -1; i <= 8; i++) {
    const d = addDays(a.y, a.mo, a.d, i);
    if (new Date(Date.UTC(d.y, d.mo - 1, d.d)).getUTCDay() !== day) continue;
    const at = zonedToUtc(d.y, d.mo, d.d, t.h, t.mi, w.tz);
    if (at > after) return at;
  }
  return null;
}

function inWeeklyClosure(w: WeeklyClosure, now: number): boolean {
  if (!w.enabled) return false;
  const p = zonedParts(now, w.tz);
  const wm = p.dow * 1440 + p.h * 60 + p.mi;
  const ct = parseHHMM(w.closeTime);
  const ot = parseHHMM(w.openTime);
  const closeIdx = w.closeDay * 1440 + ct.h * 60 + ct.mi;
  const openIdx = w.openDay * 1440 + ot.h * 60 + ot.mi;
  return closeIdx < openIdx ? wm >= closeIdx && wm < openIdx : wm >= closeIdx || wm < openIdx;
}

export function marketStatus(s: SessionsSettings, now: number): MarketStatus {
  const windows = s.closedWindows.map((w) => ({ ...w, a: Date.parse(w.start), b: Date.parse(w.end) }));
  const closedBy = (t: number): { reason: 'weekend' | 'closed_window'; label: string } | null => {
    const w = windows.find((x) => t >= x.a && t < x.b);
    if (w) return { reason: 'closed_window', label: w.label };
    if (inWeeklyClosure(s.weeklyClosure, t)) return { reason: 'weekend', label: 'Weekly market closure' };
    return null;
  };
  const wk = s.weeklyClosure;
  const now0 = closedBy(now);
  if (now0) {
    // Walk forward across back-to-back closures (a holiday window touching the weekend) to the real reopening.
    let t = now;
    for (let i = 0; i < 20; i++) {
      const candidates: number[] = [];
      for (const w of windows) if (t >= w.a && t < w.b) candidates.push(w.b);
      if (inWeeklyClosure(wk, t)) { const o = weeklyBoundary(wk, t, 'open'); if (o) candidates.push(o); }
      if (!candidates.length) break;
      t = Math.max(...candidates);
      if (!closedBy(t)) return { state: 'closed', ...now0, changesAt: t };
    }
    return { state: 'closed', ...now0, changesAt: null };
  }
  const next: number[] = [];
  if (wk.enabled) { const c = weeklyBoundary(wk, now, 'close'); if (c) next.push(c); }
  for (const w of windows) if (w.a > now) next.push(w.a);
  return { state: 'open', reason: null, label: null, changesAt: next.length ? Math.min(...next) : null };
}

export interface SessionState {
  id: string;
  name: string;
  tz: string;
  /** Wall-clock time in the session's own zone, HH:MM. */
  localTime: string;
  /** Inside its own trading hours (ignores weekend/holiday closure). */
  inHours: boolean;
  /** inHours AND the gold market is open. */
  active: boolean;
  /** Start/end of the current session interval, or null when not in hours. */
  currentStart: number | null;
  currentEnd: number | null;
  nextOpen: number | null;
  nextClose: number | null;
}

export interface OverlapState { ids: [string, string]; names: [string, string]; start: number; end: number; active: boolean }
export interface UpcomingEvent { type: 'open' | 'close'; sessionId: string; name: string; at: number }

export interface SessionsSnapshot {
  now: number;
  market: MarketStatus;
  sessions: SessionState[];
  /** Overlaps in progress, plus the next one for each pair. */
  overlaps: OverlapState[];
  upcoming: UpcomingEvent[];
}

const HORIZON = 9 * 86_400_000;
const hhmm = (ms: number, tz: string) => { const p = zonedParts(ms, tz); return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };

export function sessionsSnapshot(settings: SessionsSettings, now: number): SessionsSnapshot {
  const market = marketStatus(settings, now);
  const defs = settings.sessions.filter((s) => s.enabled);
  const intervals = new Map(defs.map((d) => [d.id, sessionIntervals(d, now - 86_400_000 * 2, now + HORIZON).sort((x, y) => x.start - y.start)]));
  const sessions: SessionState[] = defs.map((d) => {
    const iv = intervals.get(d.id)!;
    const cur = iv.find((i) => i.start <= now && now < i.end) ?? null;
    const nxt = iv.find((i) => i.start > now) ?? null;
    return {
      id: d.id, name: d.name, tz: d.tz, localTime: hhmm(now, d.tz),
      inHours: !!cur, active: !!cur && market.state === 'open',
      currentStart: cur?.start ?? null, currentEnd: cur?.end ?? null,
      nextOpen: nxt?.start ?? null, nextClose: cur ? cur.end : (nxt?.end ?? null),
    };
  });
  const overlaps: OverlapState[] = [];
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const found: OverlapState[] = [];
      for (const x of intervals.get(defs[i]!.id)!) {
        for (const y of intervals.get(defs[j]!.id)!) {
          const start = Math.max(x.start, y.start);
          const end = Math.min(x.end, y.end);
          if (end > start && end > now) found.push({ ids: [defs[i]!.id, defs[j]!.id], names: [defs[i]!.name, defs[j]!.name], start, end, active: start <= now });
        }
      }
      found.sort((a, b) => a.start - b.start);
      overlaps.push(...found.filter((o) => o.active), ...found.filter((o) => !o.active).slice(0, 1));
    }
  }
  overlaps.sort((a, b) => a.start - b.start);
  const upcoming: UpcomingEvent[] = [];
  for (const d of defs) {
    for (const iv of intervals.get(d.id)!) {
      if (iv.start > now) upcoming.push({ type: 'open', sessionId: d.id, name: d.name, at: iv.start });
      if (iv.end > now) upcoming.push({ type: 'close', sessionId: d.id, name: d.name, at: iv.end });
    }
  }
  upcoming.sort((a, b) => a.at - b.at);
  return { now, market, sessions, overlaps, upcoming: upcoming.slice(0, 8) };
}

/** Human duration like "2h 15m". */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mi}m` : `${mi}m`;
}
