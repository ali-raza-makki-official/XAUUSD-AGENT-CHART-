import { z } from 'zod';

/**
 * Sends the morning briefing once per day at the chosen local time, only while Aurum is running.
 * If the app was closed at that time the briefing is skipped, never sent hours late.
 */
export const BriefingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  tz: z.string().min(1).max(64).default(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  weekdaysOnly: z.boolean().default(true),
});
export type BriefingSettings = z.infer<typeof BriefingSettingsSchema>;

export interface SchedulerDeps {
  settings: () => BriefingSettings;
  /** The last local date (YYYY-MM-DD) a briefing was sent, persisted by the caller. */
  lastSent: () => string | null;
  markSent: (date: string) => void;
  send: () => Promise<boolean>;
  now?: () => number;
  /** How late after the chosen minute a briefing may still go out. */
  windowMin?: number;
}

const parts = (ms: number, tz: string) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(ms));
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: (Number(g('hour')) % 24) * 60 + Number(g('minute')), weekday: g('weekday') };
};

/** Returns true when a briefing was sent by this call. Call it about once a minute. */
export async function tickBriefing(d: SchedulerDeps): Promise<boolean> {
  const s = d.settings();
  if (!s.enabled) return false;
  let p;
  try { p = parts((d.now ?? Date.now)(), s.tz); } catch { return false; } // unknown time zone: do nothing
  if (s.weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) return false;
  const [hh, mm] = s.time.split(':').map(Number) as [number, number];
  const due = hh * 60 + mm, late = p.minutes - due;
  if (late < 0 || late > (d.windowMin ?? 15)) return false;
  if (d.lastSent() === p.date) return false;
  d.markSent(p.date); // mark first: a failed send must not repeat every minute
  return d.send();
}
