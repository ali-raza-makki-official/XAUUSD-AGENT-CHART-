import { z } from 'zod';
import { pipsToPrice, priceToPips } from './risk';
import { zoneBroken, zoneReached } from './assistant';

/**
 * Paper trades: what WOULD have happened if an idea had been traded, judged on the real recorded price ticks.
 * Entries fill on the ask (buys) or bid (sells) and exits on the opposite side, so the spread is paid like in real trading.
 * If one tick could be read as both stop and target, the stop counts (never flatter the result).
 */
export const PaperStatusSchema = z.enum(['pending', 'open', 'won', 'lost', 'timeout', 'expired']);
export type PaperStatus = z.infer<typeof PaperStatusSchema>;

export const PaperTradeSchema = z.object({
  id: z.string().min(6).max(100),
  createdAt: z.number().int(),
  /** Where the idea came from: a trade plan, an AI analysis card, or the user's own view. */
  source: z.enum(['plan', 'analysis', 'user']),
  sourceId: z.string().max(100).optional(),
  side: z.enum(['buy', 'sell']),
  /** touch: enter when price reaches the zone; limit: enter when price reaches the zone edge; market: already open at creation. */
  entry: z.enum(['touch', 'limit', 'market']),
  zone: z.object({ low: z.number().positive(), high: z.number().positive() }).optional(),
  slPips: z.number().positive(),
  tpPips: z.number().positive().nullable(),
  /** Pending ideas are dropped at this time (ms). */
  expiresAt: z.number().int(),
  /** An open paper trade is closed at market after this long (ms). */
  maxHoldMs: z.number().int().positive(),
  status: PaperStatusSchema,
  endReason: z.string().max(200).default(''),
  openedAt: z.number().int().optional(),
  openPrice: z.number().optional(),
  sl: z.number().optional(),
  tp: z.number().nullable().optional(),
  closedAt: z.number().int().optional(),
  closePrice: z.number().optional(),
  /** Signed pips, positive = profit (spread included). */
  resultPips: z.number().optional(),
  /** Best and worst the trade was while open, in pips. */
  mfePips: z.number().default(0),
  maePips: z.number().default(0),
  /** True when the same idea was also placed as a real order. */
  live: z.boolean().default(false),
  tags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  note: z.string().max(400).default(''),
});
export type PaperTrade = z.infer<typeof PaperTradeSchema>;

export interface PaperTick { ts: number; bid: number; ask: number }

const r1 = (v: number) => Math.round(v * 10) / 10;
export const isActive = (t: Pick<PaperTrade, 'status'>) => t.status === 'pending' || t.status === 'open';

function openAt(t: PaperTrade, price: number, ts: number, pipSize: number): PaperTrade {
  const buy = t.side === 'buy';
  const sl = buy ? price - pipsToPrice(t.slPips, pipSize) : price + pipsToPrice(t.slPips, pipSize);
  const tp = t.tpPips === null ? null : buy ? price + pipsToPrice(t.tpPips, pipSize) : price - pipsToPrice(t.tpPips, pipSize);
  return { ...t, status: 'open', openedAt: ts, openPrice: price, sl, tp };
}

function close(t: PaperTrade, status: 'won' | 'lost' | 'timeout', price: number, ts: number, pipSize: number, why: string): PaperTrade {
  const pips = priceToPips(t.side === 'buy' ? price - t.openPrice! : t.openPrice! - price, pipSize);
  return { ...t, status, closedAt: ts, closePrice: price, resultPips: r1(pips), endReason: why };
}

/** Advance one paper trade by one real tick. Returns the same object when nothing changed. */
export function paperStep(t: PaperTrade, tick: PaperTick, pipSize: number): PaperTrade {
  if (!isActive(t)) return t;
  const buy = t.side === 'buy';
  if (t.status === 'pending') {
    if (tick.ts >= t.expiresAt) return { ...t, status: 'expired', closedAt: tick.ts, endReason: 'Price never reached the entry before the idea expired.' };
    if (t.entry === 'market') return openAt(t, buy ? tick.ask : tick.bid, tick.ts, pipSize);
    if (!t.zone) return t;
    const px = { bid: tick.bid, ask: tick.ask };
    if (t.entry === 'touch') {
      if (zoneBroken({ side: t.side, zone: t.zone }, px)) return { ...t, status: 'expired', closedAt: tick.ts, endReason: 'Price went through the zone without a usable touch.' };
      if (zoneReached({ side: t.side, zone: t.zone }, px)) return openAt(t, buy ? tick.ask : tick.bid, tick.ts, pipSize);
      return t;
    }
    // limit at the zone edge nearest to price
    const edge = buy ? t.zone.high : t.zone.low;
    if (buy ? tick.ask <= edge : tick.bid >= edge) return openAt(t, edge, tick.ts, pipSize);
    return t;
  }
  // open
  const exit = buy ? tick.bid : tick.ask;
  const pips = priceToPips(buy ? exit - t.openPrice! : t.openPrice! - exit, pipSize);
  let next = t;
  if (pips > t.mfePips) next = { ...next, mfePips: r1(pips) };
  if (-pips > t.maePips) next = { ...next, maePips: r1(-pips) };
  const slHit = buy ? tick.bid <= t.sl! : tick.ask >= t.sl!;
  if (slHit) return close(next, 'lost', t.sl!, tick.ts, pipSize, `Stop of ${t.slPips} pips hit.`);
  const tpHit = t.tp != null && (buy ? tick.bid >= t.tp : tick.ask <= t.tp);
  if (tpHit) return close(next, 'won', t.tp!, tick.ts, pipSize, `Target of ${t.tpPips} pips hit.`);
  if (tick.ts - t.openedAt! >= t.maxHoldMs) return close(next, 'timeout', exit, tick.ts, pipSize, 'Closed at market after the maximum holding time.');
  return next;
}

// ------------------------------------------------------------------------------------ statistics

export interface GroupStat { key: string; n: number; wins: number; losses: number; winRate: number | null; avgPips: number | null; expectancy: number | null; profitFactor: number | null }

const finished = (t: PaperTrade) => (t.status === 'won' || t.status === 'lost' || t.status === 'timeout') && t.resultPips !== undefined;

/** Win rate, average and expectancy in pips per group. Timed-out trades count by the sign of their result. */
export function groupStats(trades: readonly PaperTrade[], keyOf: (t: PaperTrade) => string): GroupStat[] {
  const groups = new Map<string, PaperTrade[]>();
  for (const t of trades.filter(finished)) { const k = keyOf(t); (groups.get(k) ?? groups.set(k, []).get(k)!).push(t); }
  const out: GroupStat[] = [];
  for (const [key, list] of groups) {
    const wins = list.filter((t) => t.resultPips! > 0), losses = list.filter((t) => t.resultPips! < 0);
    const gw = wins.reduce((s, t) => s + t.resultPips!, 0), gl = Math.abs(losses.reduce((s, t) => s + t.resultPips!, 0));
    const sum = list.reduce((s, t) => s + t.resultPips!, 0);
    out.push({ key, n: list.length, wins: wins.length, losses: losses.length, winRate: Math.round((wins.length / list.length) * 1000) / 10, avgPips: r1(sum / list.length), expectancy: r1(sum / list.length), profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** The labels paper trades are grouped by. Hours are UTC. */
export function sessionOfHour(hourUtc: number): string {
  return hourUtc < 7 ? 'Asia' : hourUtc < 12 ? 'London' : hourUtc < 16 ? 'London/New York overlap' : hourUtc < 21 ? 'New York' : 'Late / rollover';
}
export const PAPER_KEYS: Record<string, (t: PaperTrade) => string> = {
  source: (t) => t.source,
  side: (t) => t.side,
  session: (t) => String(t.tags.session ?? 'unknown'),
  weekday: (t) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date((t.openedAt ?? t.createdAt)).getUTCDay()]!,
  entry: (t) => t.entry,
  rewardRisk: (t) => (t.tpPips === null ? 'no target' : t.tpPips / t.slPips >= 2 ? '2R or more' : t.tpPips / t.slPips >= 1.5 ? '1.5R-2R' : 'under 1.5R'),
  live: (t) => (t.live ? 'also placed live' : 'paper only'),
};

// -------------------------------------------------------------------------------- what-if replay

/** Everything that happened to a trade after entry, boiled down so any stop/target pair can be tested without replaying ticks again. */
export interface PaperPath { ts: number[]; fav: number[]; adv: number[] }

/** Cumulative best-for and worst-for the trade (pips) at each tick after entry. */
export function buildPath(side: 'buy' | 'sell', openPrice: number, ticks: readonly PaperTick[], pipSize: number): PaperPath {
  const ts: number[] = [], fav: number[] = [], adv: number[] = [];
  let f = 0, a = 0;
  for (const k of ticks) {
    const exit = side === 'buy' ? k.bid : k.ask;
    const pips = priceToPips(side === 'buy' ? exit - openPrice : openPrice - exit, pipSize);
    f = Math.max(f, pips); a = Math.max(a, -pips);
    ts.push(k.ts); fav.push(f); adv.push(a);
  }
  return { ts, fav, adv };
}

/** Result in pips of a given stop/target on a recorded path; the stop wins a tie. null = neither was reached (use the last price). */
export function pathResult(path: PaperPath, slPips: number, tpPips: number | null, lastPips: number): number {
  const first = (arr: number[], level: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]! >= level) hi = m; else lo = m + 1; } return lo < arr.length ? lo : -1; };
  const iSl = first(path.adv, slPips);
  const iTp = tpPips === null ? -1 : first(path.fav, tpPips);
  if (iSl === -1 && iTp === -1) return r1(lastPips);
  if (iTp === -1 || (iSl !== -1 && iSl <= iTp)) return -slPips;
  return tpPips!;
}

export interface ComboResult { slPips: number; tpPips: number; n: number; winRate: number; expectancy: number; profitFactor: number | null }

/** Tries stop/target pairs on what really happened after each entry and ranks them by average pips per trade. */
export function rankCombos(paths: readonly { path: PaperPath; lastPips: number }[], slGrid: readonly number[], tpGrid: readonly number[]): ComboResult[] {
  const out: ComboResult[] = [];
  if (!paths.length) return out;
  for (const sl of slGrid) for (const tp of tpGrid) {
    let sum = 0, wins = 0, gw = 0, gl = 0;
    for (const p of paths) { const r = pathResult(p.path, sl, tp, p.lastPips); sum += r; if (r > 0) { wins++; gw += r; } else if (r < 0) gl += -r; }
    out.push({ slPips: sl, tpPips: tp, n: paths.length, winRate: Math.round((wins / paths.length) * 1000) / 10, expectancy: r1(sum / paths.length), profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null });
  }
  return out.sort((a, b) => b.expectancy - a.expectancy);
}
