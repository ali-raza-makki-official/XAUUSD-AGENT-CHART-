import type { ClosedTrade } from './performance';

/**
 * Behaviour flags from REAL closed trades: patterns that usually mean emotion rather than plan.
 * They are observations with the trades that triggered them, not accusations; a flag can be a fine decision.
 */
export interface BehaviorFlag {
  id: 'size_up_after_loss' | 'quick_reentry' | 'overtrading_day' | 'overtrading_hour' | 'losers_run' | 'streak_continued';
  title: string;
  detail: string;
  /** Position ids of the trades that triggered the flag (newest first, at most 8). */
  positions: number[];
}

export interface BehaviorOptions {
  /** Opened this soon after a loss counts as a quick re-entry. */
  reentryMin: number;
  /** A bigger lot size than the losing trade by this factor, soon after the loss. */
  sizeUpFactor: number;
  maxTradesPerDay: number;
  maxTradesPerHour: number;
}
export const DEFAULT_BEHAVIOR: BehaviorOptions = { reentryMin: 5, sizeUpFactor: 1.25, maxTradesPerDay: 6, maxTradesPerHour: 3 };

const dayKey = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

export function behaviorFlags(trades: readonly ClosedTrade[], o: BehaviorOptions = DEFAULT_BEHAVIOR): BehaviorFlag[] {
  const sorted = [...trades].sort((a, b) => (a.openTime ?? a.closeTime) - (b.openTime ?? b.closeTime));
  const flags: BehaviorFlag[] = [];
  const quick: number[] = [], sizeUp: number[] = [], streakGo: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, cur = sorted[i]!;
    if (prev.net >= 0 || cur.openTime === null) continue;
    const gapMin = (cur.openTime - prev.closeTime) / 60;
    if (gapMin < 0 || gapMin > 15) continue;
    if (gapMin <= o.reentryMin) quick.push(cur.positionId);
    if (cur.volume >= prev.volume * o.sizeUpFactor) sizeUp.push(cur.positionId);
    const prev2 = sorted[i - 2];
    if (prev2 && prev2.net < 0) streakGo.push(cur.positionId);
  }
  const newest = (a: number[]) => [...a].reverse().slice(0, 8);
  if (sizeUp.length) flags.push({ id: 'size_up_after_loss', title: 'Bigger size right after a loss', detail: `${sizeUp.length} time(s) a trade was opened within 15 minutes of a loss with at least ${Math.round((o.sizeUpFactor - 1) * 100)}% more lots. This is the classic way to turn a small loss into a big one.`, positions: newest(sizeUp) });
  if (quick.length) flags.push({ id: 'quick_reentry', title: `Re-entered within ${o.reentryMin} minutes of a loss`, detail: `${quick.length} time(s). Fast re-entries after a loss are often revenge trades; check whether each had a fresh setup.`, positions: newest(quick) });
  if (streakGo.length) flags.push({ id: 'streak_continued', title: 'Kept trading after two losses in a row', detail: `${streakGo.length} time(s) a third trade followed two losses within 15 minutes. A short break usually helps more than another entry.`, positions: newest(streakGo) });

  const perDay = new Map<string, number[]>();
  for (const t of sorted) { const k = dayKey(t.openTime ?? t.closeTime); (perDay.get(k) ?? perDay.set(k, []).get(k)!).push(t.positionId); }
  const busy = [...perDay].filter(([, l]) => l.length > o.maxTradesPerDay);
  if (busy.length) flags.push({ id: 'overtrading_day', title: `More than ${o.maxTradesPerDay} trades in a day`, detail: `Days: ${busy.map(([d, l]) => `${d} (${l.length})`).join(', ')}.`, positions: newest(busy.flatMap(([, l]) => l)) });

  const times = sorted.map((t) => ({ id: t.positionId, at: t.openTime ?? t.closeTime }));
  const hot = new Set<number>();
  for (let i = 0; i < times.length; i++) {
    const win = times.filter((x) => x.at >= times[i]!.at && x.at < times[i]!.at + 3600);
    if (win.length > o.maxTradesPerHour) win.forEach((x) => hot.add(x.id));
  }
  if (hot.size) flags.push({ id: 'overtrading_hour', title: `More than ${o.maxTradesPerHour} trades within one hour`, detail: `${hot.size} trades were part of a burst. Bursts are where discipline usually slips.`, positions: newest([...hot]) });

  const wins = sorted.filter((t) => t.net > 0 && t.heldSec !== null), losses = sorted.filter((t) => t.net < 0 && t.heldSec !== null);
  if (wins.length >= 3 && losses.length >= 3) {
    const avg = (l: ClosedTrade[]) => l.reduce((s, t) => s + t.heldSec!, 0) / l.length;
    if (avg(losses) > avg(wins) * 2) flags.push({ id: 'losers_run', title: 'Losers are held much longer than winners', detail: `Average losing trade ${Math.round(avg(losses) / 60)} min vs winning ${Math.round(avg(wins) / 60)} min. Winners may be cut short while losers are left to run.`, positions: [] });
  }
  return flags;
}
