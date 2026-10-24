import { describe, expect, it } from 'vitest';
import {
  INDICATORS, INDICATOR_TYPES, atr, bollinger, computeIndicator, defaultParams, ema, macd, resolveParams, rsi, sma, sourceSeries,
  stochastic, supertrend, tailValues, trueRange, vwap, wma, type Candle,
} from '../src';

const close = (...v: number[]): Candle[] => v.map((c, i) => ({ time: i * 60, open: c, high: c, low: c, close: c, volume: 1 }));
const bar = (time: number, high: number, low: number, c: number, volume = 1): Candle => ({ time, open: c, high, low, close: c, volume });
const near = (a: number[], b: number[], digits = 6) => {
  expect(a).toHaveLength(b.length);
  b.forEach((v, i) => (Number.isNaN(v) ? expect(a[i], `index ${i}`).toBeNaN() : expect(a[i], `index ${i}`).toBeCloseTo(v, digits)));
};

describe('moving averages', () => {
  it('SMA matches hand values and is NaN during warm-up', () => {
    near(sma([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
    near(sma([10], 1), [10]);
  });

  it('EMA is seeded with the SMA and then smooths with alpha = 2/(n+1)', () => {
    // alpha 0.5: seed (1+2+3)/3 = 2, then 0.5*4+0.5*2 = 3, then 4
    near(ema([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
    // period 5 -> alpha 1/3. Step up: seed 10, next 20/3 + 2*10/3 = 13.3333
    near(ema([10, 10, 10, 10, 10, 20], 5), [NaN, NaN, NaN, NaN, 10, 40 / 3]);
  });

  it('WMA weights the newest value most', () => {
    near(wma([1, 2, 3, 4, 5], 3), [NaN, NaN, 14 / 6, 20 / 6, 26 / 6]);
  });

  it('returns all-NaN of the same length when there are fewer values than the period', () => {
    for (const fn of [sma, ema, wma]) {
      const r = fn([1, 2], 5);
      expect(r).toHaveLength(2);
      expect(r.every(Number.isNaN)).toBe(true);
    }
    expect(sma([], 3)).toEqual([]);
  });

  it('rejects an invalid period without throwing', () => {
    expect(sma([1, 2, 3], 0).every(Number.isNaN)).toBe(true);
    expect(ema([1, 2, 3], 1.5).every(Number.isNaN)).toBe(true);
  });

  it('NaN inside a window gives NaN and EMA re-seeds afterwards', () => {
    near(sma([1, 2, NaN, 4, 5, 6], 2), [NaN, 1.5, NaN, NaN, 4.5, 5.5]);
    // EMA(2): alpha 2/3. seed idx1 = 1.5, idx2 = 2.5; the NaN resets; re-seed from 5,6 -> 5.5 at idx5
    near(ema([1, 2, 3, NaN, 5, 6], 2), [NaN, 1.5, 2.5, NaN, NaN, 5.5]);
  });
});

describe('RSI (Wilder)', () => {
  it('matches a hand-computed period-2 case', () => {
    // changes +1 -1 +1 -> first avg gain/loss .5/.5 -> 50; then (0.5*1+1)/2=.75 and (0.5*1+0)/2=.25 -> RS 3 -> 75
    near(rsi([1, 2, 1, 2], 2), [NaN, NaN, 50, 75]);
  });

  it('matches an independently computed 14-period Wilder series (classic textbook closes)', () => {
    // StockCharts publishes 70.53/66.32/66.55/69.41/66.36/57.97 for these closes; the small gap comes from the rounded
    // intermediate averages in their spreadsheet. These expected values were computed separately with full precision.
    const px = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const r = rsi(px, 14);
    expect(r.slice(0, 14).every(Number.isNaN)).toBe(true);
    [70.46413502, 66.24961855, 66.48094183, 69.34685316, 66.29471266, 57.91502067].forEach((v, k) => expect(r[14 + k]).toBeCloseTo(v, 6));
  });

  it('is 100 with no losses and 0 with no gains; stays in 0..100', () => {
    near(rsi([1, 2, 3, 4], 2), [NaN, NaN, 100, 100]);
    near(rsi([4, 3, 2, 1], 2), [NaN, NaN, 0, 0]);
    const noisy = rsi(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5 + (i % 7)), 14).filter((v) => !Number.isNaN(v));
    expect(Math.min(...noisy)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...noisy)).toBeLessThanOrEqual(100);
  });

  it('needs period + 1 prices', () => {
    expect(rsi([1, 2, 3], 14).every(Number.isNaN)).toBe(true);
  });
});

describe('MACD', () => {
  it('equals fast EMA minus slow EMA, with signal and histogram (hand case)', () => {
    // linear series: EMA(2) = x - 0.5, EMA(3) = x - 1, so macd = 0.5 everywhere it is defined
    const r = macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
    near(r.macd, [NaN, NaN, 0.5, 0.5, 0.5, 0.5]);
    near(r.signal, [NaN, NaN, NaN, 0.5, 0.5, 0.5]);
    near(r.histogram, [NaN, NaN, NaN, 0, 0, 0]);
  });

  it('is zero on a flat market', () => {
    const r = macd(new Array(60).fill(100), 12, 26, 9);
    expect(r.macd[59]).toBeCloseTo(0, 12);
    expect(r.histogram[59]).toBeCloseTo(0, 12);
    expect(r.macd[24]).toBeNaN();
    expect(r.signal[32]).toBeNaN();
    expect(r.signal[33]).not.toBeNaN(); // slow(26) + signal(9) - 1 = 34th value
  });
});

describe('Bollinger Bands', () => {
  it('uses the population standard deviation', () => {
    const b = bollinger([1, 2, 3, 4, 5], 3, 2);
    const sd = Math.sqrt(2 / 3);
    near(b.middle, [NaN, NaN, 2, 3, 4]);
    near(b.upper, [NaN, NaN, 2 + 2 * sd, 3 + 2 * sd, 4 + 2 * sd]);
    near(b.lower, [NaN, NaN, 2 - 2 * sd, 3 - 2 * sd, 4 - 2 * sd]);
  });

  it('collapses to the average on a flat market', () => {
    const b = bollinger([5, 5, 5, 5], 3, 2);
    expect(b.upper[3]).toBe(5);
    expect(b.lower[3]).toBe(5);
  });
});

describe('ATR', () => {
  const cs = [bar(0, 10, 8, 9), bar(60, 11, 9, 10), bar(120, 13, 10, 12), bar(180, 12, 11, 11.5)];

  it('true range uses the previous close and the first bar is high - low', () => {
    near(trueRange(cs), [2, 2, 3, 1]);
    // gap up: previous close 10, bar 14-13 -> max(1, 4, 3) = 4
    near(trueRange([bar(0, 11, 9, 10), bar(60, 14, 13, 13.5)]), [2, 4]);
  });

  it('Wilder ATR seeds with the SMA of the first TRs', () => {
    near(atr(cs, 2), [NaN, 2, 2.5, 1.75]);
  });

  it('is NaN with fewer candles than the period', () => {
    expect(atr(cs.slice(0, 2), 5).every(Number.isNaN)).toBe(true);
  });
});

describe('Stochastic', () => {
  const cs = [bar(0, 10, 5, 8), bar(60, 12, 6, 11), bar(120, 11, 7, 8), bar(180, 13, 8, 12)];

  it('computes %K and %D by hand', () => {
    const r = stochastic(cs, 3, 1, 2);
    near(r.k, [NaN, NaN, (3 / 7) * 100, (6 / 7) * 100]);
    near(r.d, [NaN, NaN, NaN, (((3 / 7) + (6 / 7)) / 2) * 100]);
  });

  it('applies %K smoothing', () => {
    const r = stochastic(cs, 3, 2, 1);
    near(r.k, [NaN, NaN, NaN, (((3 / 7) + (6 / 7)) / 2) * 100]);
  });

  it('is NaN (not a fake number) when the range is flat', () => {
    const flat = [bar(0, 5, 5, 5), bar(60, 5, 5, 5), bar(120, 5, 5, 5)];
    expect(stochastic(flat, 3, 1, 1).k[2]).toBeNaN();
  });
});

describe('VWAP (tick volume)', () => {
  it('weights the typical price by tick volume and restarts each session', () => {
    const cs = [
      { time: 0, open: 10, high: 12, low: 8, close: 10, volume: 100 },       // tp 10
      { time: 3600, open: 12, high: 14, low: 10, close: 12, volume: 300 },   // tp 12
      { time: 86400, open: 20, high: 20, low: 20, close: 20, volume: 50 },   // next day -> reset
    ];
    near(vwap(cs), [10, (10 * 100 + 12 * 300) / 400, 20]);
  });

  it('is NaN while no volume has traded and honours the session start hour', () => {
    const cs = [bar(0, 10, 10, 10, 0), bar(60, 10, 10, 10, 5)];
    near(vwap(cs), [NaN, 10]);
    // session starts at 01:00 -> a candle at 00:30 belongs to the previous session
    const two = [bar(1800, 10, 10, 10, 10), bar(3600, 20, 20, 20, 10)];
    near(vwap(two, 1), [10, 20]);
    near(vwap(two, 0), [10, 15]);
  });

  it('is labelled as tick-volume based in the registry', () => {
    expect(INDICATORS.vwap.name).toMatch(/tick volume/i);
    expect(INDICATORS.vwap.usesTickVolume).toBe(true);
  });
});

describe('Supertrend', () => {
  it('follows the standard algorithm (hand case, ATR period 1, multiplier 1)', () => {
    const cs = [bar(0, 10, 8, 9), bar(60, 12, 9, 11.5), bar(120, 11, 5, 6)];
    const s = supertrend(cs, 1, 1);
    near(s.up, [7, 7.5, NaN]);
    near(s.down, [NaN, NaN, 14.5]);
    near(s.direction, [1, 1, -1]);
  });

  it('is undefined until ATR is defined', () => {
    const s = supertrend([bar(0, 10, 8, 9), bar(60, 11, 9, 10)], 5, 3);
    expect(s.direction.every(Number.isNaN)).toBe(true);
  });
});

describe('registry', () => {
  it('describes every indicator completely and computes without throwing on defaults', () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => bar(i * 900, 100 + i * 0.1 + 2, 100 + i * 0.1 - 2, 100 + i * 0.1 + Math.sin(i), 10 + i));
    for (const t of INDICATOR_TYPES) {
      const def = INDICATORS[t];
      expect(def.outputs.length).toBeGreaterThan(0);
      expect(['overlay', 'pane']).toContain(def.placement);
      const out = computeIndicator(t, candles, defaultParams(t));
      for (const o of def.outputs) expect(out[o.key], `${t}.${o.key}`).toHaveLength(candles.length);
      expect(def.outputs.some((o) => out[o.key]!.some((v) => !Number.isNaN(v))), `${t} has values`).toBe(true);
      for (const p of def.params) {
        if (p.type !== 'select') {
          expect(p.default).toBeGreaterThanOrEqual(p.min);
          expect(p.default).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });

  it('puts RSI/MACD/ATR/Stochastic in their own pane and the rest on price', () => {
    expect(INDICATORS.rsi.placement).toBe('pane');
    expect(INDICATORS.macd.placement).toBe('pane');
    expect(INDICATORS.atr.placement).toBe('pane');
    expect(INDICATORS.stochastic.placement).toBe('pane');
    for (const t of ['sma', 'ema', 'wma', 'bollinger', 'vwap', 'supertrend'] as const) expect(INDICATORS[t].placement).toBe('overlay');
  });

  it('validates parameters: ranges, integers, unknown keys, selects, MACD ordering', () => {
    expect(resolveParams('sma', {})).toEqual({ ok: true, params: { period: 20, source: 'close' } });
    expect(resolveParams('sma', { period: 0 })).toMatchObject({ ok: false });
    expect(resolveParams('sma', { period: 501 })).toMatchObject({ ok: false });
    expect(resolveParams('sma', { period: 2.5 })).toMatchObject({ ok: false });
    expect(resolveParams('sma', { bogus: 1 })).toMatchObject({ ok: false });
    expect(resolveParams('sma', { source: 'nope' })).toMatchObject({ ok: false });
    expect(resolveParams('sma', { period: '5' })).toMatchObject({ ok: false });
    expect(resolveParams('macd', { fast: 30, slow: 20 })).toMatchObject({ ok: false });
    expect(resolveParams('bollinger', { mult: 2.5 })).toMatchObject({ ok: true });
  });

  it('computeIndicator throws on invalid params instead of returning garbage', () => {
    expect(() => computeIndicator('sma', close(1, 2, 3), { period: -1 })).toThrow();
  });

  it('sourceSeries picks the requested price', () => {
    const c = [{ time: 0, open: 1, high: 4, low: 0, close: 3, volume: 0 }];
    expect(sourceSeries(c, 'hl2')).toEqual([2]);
    expect(sourceSeries(c, 'hlc3')).toEqual([7 / 3]);
    expect(sourceSeries(c, 'ohlc4')).toEqual([2]);
    expect(sourceSeries(c)).toEqual([3]);
  });

  it('tailValues returns the last N defined rows with null for undefined outputs', () => {
    const cs = close(1, 2, 3, 4, 5);
    const out = computeIndicator('sma', cs, { period: 3 });
    expect(tailValues(cs, out, ['value'], 2)).toEqual([[180, 3], [240, 4]]);
    expect(tailValues(cs, out, ['value'], 10)).toHaveLength(3); // the 2 warm-up rows are skipped
  });
});
