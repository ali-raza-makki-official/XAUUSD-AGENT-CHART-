/** Time-zone maths on top of Intl (IANA zones, correct DST). No tables of offsets are hard-coded anywhere. */

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmts.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try { fmt(tz); return true; } catch { return false; }
}

export interface ZonedParts { y: number; mo: number; d: number; h: number; mi: number; s: number; /** 0 = Sunday */ dow: number }
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second!, dow: DOW[p.weekday!]! };
}

/** Offset of the zone from UTC at an instant, in ms (positive = ahead of UTC). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Wall-clock time in a zone to a UTC instant. Ambiguous times (clocks go back) resolve to the first
 * occurrence; non-existent times (clocks go forward) resolve to the moment just after the gap.
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const DAY = 86_400_000;
  const cands = [...new Set([naive - tzOffsetMs(naive - DAY, tz), naive - tzOffsetMs(naive + DAY, tz)])].sort((a, b) => a - b);
  for (const c of cands) {
    const p = zonedParts(c, tz);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return c;
  }
  return naive - tzOffsetMs(naive - DAY, tz); // inside a spring-forward gap
}

/** Add whole calendar days to a y/m/d triple. */
export function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function parseHHMM(s: string): { h: number; mi: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`Invalid time '${s}', expected HH:MM`);
  return { h: +m[1]!, mi: +m[2]! };
}
