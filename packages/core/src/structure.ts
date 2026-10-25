import { type Candle } from './feed';

/**
 * Deterministic market-structure detection on real candles. Every result carries the exact candle times and
 * prices it was derived from, so a drawing made from it is anchored to data, not to a guess.
 * Definitions are the common smart-money / price-action ones; they are heuristics, not signals.
 */

export interface Fvg {
  kind: 'fvg'; direction: 'bullish' | 'bearish';
  /** Time of the first and third candle of the 3-candle pattern. */
  startTime: number; endTime: number;
  top: number; bottom: number;
  /** 'open' = price has not traded back into it; 'partial' = entered but not filled; 'filled' = fully traded through. */
  status: 'open' | 'partial' | 'filled';
}
export interface Swing { kind: 'swing'; type: 'high' | 'low'; time: number; price: number; swept: boolean }
export interface LiquidityPool { kind: 'liquidity'; side: 'buy-side' | 'sell-side'; price: number; times: number[]; touches: number; swept: boolean }
export interface OrderBlock {
  kind: 'order_block'; direction: 'bullish' | 'bearish'; time: number; top: number; bottom: number;
  /** Candle at which the displacement closed beyond the prior swing. */
  breakTime: number; mitigated: boolean;
}
export interface CandlePattern { kind: 'pattern'; name: string; bias: 'bullish' | 'bearish' | 'neutral'; time: number; high: number; low: number }

export interface StructureOptions {
  /** Bars on each side that define a swing. */
  swingBars?: number;
  /** Equal-high/low tolerance as a price distance (e.g. 0.30 for gold). */
  equalTolerance: number;
  /** Ignore FVGs smaller than this price distance. */
  minGap?: number;
}

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;
const avgRange = (cs: Candle[], i: number, n = 14) => {
  let s = 0, k = 0;
  for (let j = Math.max(0, i - n); j < i; j++) { s += range(cs[j]!); k++; }
  return k ? s / k : range(cs[i]!);
};

export function findFvgs(cs: Candle[], minGap = 0): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 2; i < cs.length; i++) {
    const a = cs[i - 2]!, c = cs[i]!;
    let dir: Fvg['direction'] | null = null, top = 0, bottom = 0;
    if (c.low > a.high) { dir = 'bullish'; bottom = a.high; top = c.low; }
    else if (c.high < a.low) { dir = 'bearish'; top = a.low; bottom = c.high; }
    if (!dir || top - bottom < minGap || top - bottom <= 0) continue;
    let status: Fvg['status'] = 'open';
    for (let j = i + 1; j < cs.length; j++) {
      const k = cs[j]!;
      if (dir === 'bullish') {
        if (k.low <= bottom) { status = 'filled'; break; }
        if (k.low < top) status = 'partial';
      } else {
        if (k.high >= top) { status = 'filled'; break; }
        if (k.high > bottom) status = 'partial';
      }
    }
    out.push({ kind: 'fvg', direction: dir, startTime: a.time, endTime: c.time, top, bottom, status });
  }
  return out;
}

export function findSwings(cs: Candle[], bars = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = bars; i < cs.length - bars; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= bars; j++) {
      if (cs[i - j]!.high >= cs[i]!.high || cs[i + j]!.high > cs[i]!.high) hi = false;
      if (cs[i - j]!.low <= cs[i]!.low || cs[i + j]!.low < cs[i]!.low) lo = false;
    }
    if (hi) out.push({ kind: 'swing', type: 'high', time: cs[i]!.time, price: cs[i]!.high, swept: cs.slice(i + bars + 1).some((k) => k.high > cs[i]!.high) });
    if (lo) out.push({ kind: 'swing', type: 'low', time: cs[i]!.time, price: cs[i]!.low, swept: cs.slice(i + bars + 1).some((k) => k.low < cs[i]!.low) });
  }
  return out;
}

/** Equal highs (buy-side liquidity above) and equal lows (sell-side below): 2+ swings within the tolerance. */
export function findLiquidity(swings: Swing[], cs: Candle[], tol: number): LiquidityPool[] {
  const out: LiquidityPool[] = [];
  for (const type of ['high', 'low'] as const) {
    const s = swings.filter((x) => x.type === type).sort((a, b) => a.price - b.price);
    let group: Swing[] = [];
    const flush = () => {
      if (group.length >= 2) {
        const price = type === 'high' ? Math.max(...group.map((g) => g.price)) : Math.min(...group.map((g) => g.price));
        const last = Math.max(...group.map((g) => g.time));
        const swept = cs.some((k) => k.time > last && (type === 'high' ? k.high > price : k.low < price));
        out.push({ kind: 'liquidity', side: type === 'high' ? 'buy-side' : 'sell-side', price, times: group.map((g) => g.time).sort((a, b) => a - b), touches: group.length, swept });
      }
      group = [];
    };
    for (const sw of s) {
      if (group.length && sw.price - group[group.length - 1]!.price > tol) flush();
      group.push(sw);
    }
    flush();
  }
  return out;
}

/** Last opposite candle before a displacement candle (body > 1.5x avg range) that closes beyond the prior 5-bar extreme. */
export function findOrderBlocks(cs: Candle[]): OrderBlock[] {
  const out: OrderBlock[] = [];
  for (let i = 6; i < cs.length; i++) {
    const c = cs[i]!;
    if (body(c) < 1.5 * avgRange(cs, i)) continue;
    const prior = cs.slice(i - 5, i);
    const bull = c.close > c.open && c.close > Math.max(...prior.map((k) => k.high));
    const bear = c.close < c.open && c.close < Math.min(...prior.map((k) => k.low));
    if (!bull && !bear) continue;
    for (let j = i - 1; j >= i - 5; j--) {
      const k = cs[j]!;
      if (bull ? k.close < k.open : k.close > k.open) {
        const mitigated = cs.slice(i + 1).some((m) => (bull ? m.low <= k.high : m.high >= k.low));
        out.push({ kind: 'order_block', direction: bull ? 'bullish' : 'bearish', time: k.time, top: k.high, bottom: k.low, breakTime: c.time, mitigated });
        break;
      }
    }
  }
  return out;
}

export function findPatterns(cs: Candle[]): CandlePattern[] {
  const out: CandlePattern[] = [];
  const add = (name: string, bias: CandlePattern['bias'], c: Candle) => out.push({ kind: 'pattern', name, bias, time: c.time, high: c.high, low: c.low });
  for (let i = 2; i < cs.length; i++) {
    const c = cs[i]!, p = cs[i - 1]!, pp = cs[i - 2]!;
    const r = range(c), b = body(c), avg = avgRange(cs, i);
    if (r <= 0) continue;
    const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
    if (b <= r * 0.1) add('doji', 'neutral', c);
    else if (lower >= b * 2 && upper <= b * 0.5 && r >= avg * 0.5) add('hammer / bullish pin bar', 'bullish', c);
    else if (upper >= b * 2 && lower <= b * 0.5 && r >= avg * 0.5) add('shooting star / bearish pin bar', 'bearish', c);
    if (c.high < p.high && c.low > p.low) add('inside bar', 'neutral', c);
    if (c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close && b > body(p)) add('bullish engulfing', 'bullish', c);
    if (c.close < c.open && p.close > p.open && c.close <= p.open && c.open >= p.close && b > body(p)) add('bearish engulfing', 'bearish', c);
    if (pp.close < pp.open && body(pp) > avg * 0.6 && body(p) < body(pp) * 0.4 && c.close > c.open && c.close > (pp.open + pp.close) / 2) add('morning star', 'bullish', c);
    if (pp.close > pp.open && body(pp) > avg * 0.6 && body(p) < body(pp) * 0.4 && c.close < c.open && c.close < (pp.open + pp.close) / 2) add('evening star', 'bearish', c);
  }
  return out;
}

export interface StructureReport {
  fvgs: Fvg[]; swings: Swing[]; liquidity: LiquidityPool[]; orderBlocks: OrderBlock[]; patterns: CandlePattern[];
}

export function analyseStructure(cs: Candle[], o: StructureOptions): StructureReport {
  const swings = findSwings(cs, o.swingBars ?? 3);
  return {
    fvgs: findFvgs(cs, o.minGap ?? 0), swings, liquidity: findLiquidity(swings, cs, o.equalTolerance),
    orderBlocks: findOrderBlocks(cs), patterns: findPatterns(cs),
  };
}
