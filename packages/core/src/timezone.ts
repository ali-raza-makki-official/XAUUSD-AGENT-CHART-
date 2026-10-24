/**
 * Time-zone maths on top of Intl (no tz database bundled, no dependency). All inputs/outputs are UTC milliseconds
 * unless stated. DST is handled by asking Intl for the real offset of the zone at the real instant.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; ss: number; /** 0 = Sunday */ weekday: number }
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of a UTC instant in `tz`. */
export function localParts(utcMs: number, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) out[p.type] = p.value;
  return {
    y: Number(out.year), m: Number(out.month), d: Number(out.day),
    hh: Number(out.hour) % 24, mm: Number(out.minute), ss: Number(out.second),
    weekday: WEEKDAYS[out.weekday ?? ''] ?? 0,
  };
}

/** Offset of `tz` from UTC at that instant, in ms (positive east of Greenwich). */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const base = Math.floor(utcMs / 1000) * 1000;
  const p = localParts(base, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - base;
}

const DAY = 86_400_000;

/**
 * UTC instant of a wall-clock time in `tz`.
 * Ambiguous time (clocks go back): the first occurrence. Non-existent time (clocks go forward): shifted forward by the gap.
 */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = new Set([tzOffsetMs(naive - DAY, tz), tzOffsetMs(naive + DAY, tz)]);
  const candidates = [...offsets].map((o) => naive - o);
  const valid = candidates.filter((c) => tzOffsetMs(c, tz) === naive - c);
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
}

export interface Ymd { y: number; m: number; d: number }
export function addDays(date: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d) + n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export const weekdayOf = (date: Ymd): number => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
export const isWeekday = (date: Ymd): boolean => { const w = weekdayOf(date); return w >= 1 && w <= 5; };

export const parseHHMM = (s: string): { hh: number; mm: number } => {
  const [h, m] = s.split(':');
  return { hh: Number(h), mm: Number(m) };
};
