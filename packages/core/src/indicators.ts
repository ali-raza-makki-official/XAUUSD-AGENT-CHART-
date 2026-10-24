import type { Candle } from './feed';

/**
 * Deterministic indicator maths. Pure functions over real candles; no I/O, no randomness, no clock.
 * Every series has the SAME length as the input and holds NaN where the value is not defined yet
 * (fewer candles than the warm-up period, or NaN inside the window).
 */

export type Series = number[];

export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] as const;
export type IndicatorSource = (typeof SOURCES)[number];

export function sourceSeries(candles: readonly Candle[], source: IndicatorSource = 'close'): Series {
  return candles.map((c) => {
    switch (source) {
      case 'open': return c.open;
      case 'high': return c.high;
      case 'low': return c.low;
      case 'hl2': return (c.high + c.low) / 2;
      case 'hlc3': return (c.high + c.low + c.close) / 3;
      case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
      default: return c.close;
    }
  });
}

const nan = (n: number): Series => new Array<number>(n).fill(NaN);
const isNum = (v: number) => Number.isFinite(v);

/** Simple moving average. NaN until `period` valid values are available; any NaN in the window gives NaN. */
export function sma(values: readonly number[], period: number): Series {
  const out = nan(values.length);
  if (!Number.isInteger(period) || period < 1) return out;
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j]!;
      if (!isNum(v)) { ok = false; break; }
      s += v;
    }
    if (ok) out[i] = s / period;
  }
  return out;
}

/**
 * Exponential moving average, alpha = 2 / (period + 1), seeded with the SMA of the first `period` valid values
 * (the TradingView / TA-Lib convention). A NaN input resets the average, which then re-seeds.
 */
export function ema(values: readonly number[], period: number): Series {
  const out = nan(values.length);
  if (!Number.isInteger(period) || period < 1) return out;
  const alpha = 2 / (period + 1);
  let run = 0; // consecutive valid values seen since the last reset
  let sum = 0;
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!isNum(v)) { run = 0; sum = 0; prev = NaN; continue; }
    if (isNum(prev)) {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
      continue;
    }
    run++;
    sum += v;
    if (run === period) { prev = sum / period; out[i] = prev; }
  }
  return out;
}

/** Linearly weighted moving average: the newest value has weight `period`, the oldest weight 1. */
export function wma(values: readonly number[], period: number): Series {
  const out = nan(values.length);
  if (!Number.isInteger(period) || period < 1) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < period; k++) {
      const v = values[i - period + 1 + k]!;
      if (!isNum(v)) { ok = false; break; }
      s += v * (k + 1);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

/** Wilder smoothing (RMA): seed = SMA of first `period` valid values, then (prev*(p-1)+v)/p. */
function wilder(values: readonly number[], period: number): Series {
  const out = nan(values.length);
  let run = 0;
  let sum = 0;
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!isNum(v)) { run = 0; sum = 0; prev = NaN; continue; }
    if (isNum(prev)) { prev = (prev * (period - 1) + v) / period; out[i] = prev; continue; }
    run++;
    sum += v;
    if (run === period) { prev = sum / period; out[i] = prev; }
  }
  return out;
}

/**
 * RSI with Wilder smoothing. First value at index `period` (needs `period` price changes).
 * Zero average loss gives 100 (TradingView convention); zero average gain with losses gives 0.
 */
export function rsi(values: readonly number[], period: number): Series {
  const n = values.length;
  const gains = nan(n);
  const losses = nan(n);
  for (let i = 1; i < n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (!isNum(d)) continue;
    gains[i] = Math.max(d, 0);
    losses[i] = Math.max(-d, 0);
  }
  const ag = wilder(gains, period);
  const al = wilder(losses, period);
  return ag.map((g, i) => {
    const l = al[i]!;
    if (!isNum(g) || !isNum(l)) return NaN;
    if (l === 0) return 100;
    if (g === 0) return 0;
    return 100 - 100 / (1 + g / l);
  });
}

export interface MacdResult { macd: Series; signal: Series; histogram: Series }

export function macd(values: readonly number[], fast: number, slow: number, signalPeriod: number): MacdResult {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = f.map((v, i) => (isNum(v) && isNum(s[i]!) ? v - s[i]! : NaN));
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => (isNum(v) && isNum(signal[i]!) ? v - signal[i]! : NaN));
  return { macd: line, signal, histogram };
}

export interface BollingerResult { upper: Series; middle: Series; lower: Series }

/** Bollinger Bands: SMA +/- mult * population standard deviation (the usual charting convention). */
export function bollinger(values: readonly number[], period: number, mult: number): BollingerResult {
  const middle = sma(values, period);
  const upper = nan(values.length);
  const lower = nan(values.length);
  for (let i = 0; i < values.length; i++) {
    const m = middle[i]!;
    if (!isNum(m)) continue;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, middle, lower };
}

/** True range. The first bar has no previous close, so it is high - low. */
export function trueRange(candles: readonly Candle[]): Series {
  return candles.map((c, i) => {
    if (![c.high, c.low, c.close].every(isNum)) return NaN;
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    if (!isNum(pc)) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** Average True Range with Wilder smoothing; first value at index `period - 1`. */
export function atr(candles: readonly Candle[], period: number): Series {
  if (!Number.isInteger(period) || period < 1) return nan(candles.length);
  return wilder(trueRange(candles), period);
}

export interface StochasticResult { k: Series; d: Series }

/**
 * Stochastic oscillator. Raw %K = (close - lowest low) / (highest high - lowest low) * 100 over `kPeriod`,
 * smoothed by an SMA of `smoothK` (1 = fast stochastic), %D = SMA(%K, dPeriod). A flat range gives NaN.
 */
export function stochastic(candles: readonly Candle[], kPeriod: number, smoothK: number, dPeriod: number): StochasticResult {
  const raw = nan(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    let ok = true;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      const c = candles[j]!;
      if (!isNum(c.high) || !isNum(c.low)) { ok = false; break; }
      hh = Math.max(hh, c.high);
      ll = Math.min(ll, c.low);
    }
    const close = candles[i]!.close;
    if (ok && isNum(close) && hh > ll) raw[i] = ((close - ll) / (hh - ll)) * 100;
  }
  const k = smoothK > 1 ? sma(raw, smoothK) : raw;
  return { k, d: sma(k, dPeriod) };
}

/**
 * Session VWAP from TICK volume (MT5 candle `volume`), not exchange volume: spot gold has no central volume.
 * Typical price (H+L+C)/3 weighted by tick volume, restarting every session. A session is a 24h block of broker
 * time starting at `sessionStartHour`. NaN until the session has non-zero volume.
 */
export function vwap(candles: readonly Candle[], sessionStartHour = 0): Series {
  const out = nan(candles.length);
  let session = NaN;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const key = Math.floor((c.time - sessionStartHour * 3600) / 86400);
    if (key !== session) { session = key; pv = 0; vol = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    if (!isNum(tp) || !isNum(c.volume)) continue;
    pv += tp * c.volume;
    vol += c.volume;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

export interface SupertrendResult {
  /** Supertrend value while in an uptrend (the support line below price), else NaN. */
  up: Series;
  /** Supertrend value while in a downtrend (the resistance line above price), else NaN. */
  down: Series;
  /** +1 uptrend, -1 downtrend, NaN until defined. */
  direction: Series;
}

/** Supertrend (ATR-band trend follower) using hl2 and Wilder ATR, standard TradingView algorithm. */
export function supertrend(candles: readonly Candle[], period: number, mult: number): SupertrendResult {
  const n = candles.length;
  const up = nan(n);
  const down = nan(n);
  const direction = nan(n);
  const a = atr(candles, period);
  let finalUpper = NaN;
  let finalLower = NaN;
  let dir = NaN;
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const av = a[i]!;
    if (!isNum(av)) continue;
    const hl2 = (c.high + c.low) / 2;
    const bu = hl2 + mult * av;
    const bl = hl2 - mult * av;
    const pc = i > 0 ? candles[i - 1]!.close : NaN;
    if (!isNum(finalUpper)) {
      finalUpper = bu;
      finalLower = bl;
      dir = 1;
    } else {
      const prevUpper = finalUpper;
      const prevLower = finalLower;
      finalUpper = bu < prevUpper || pc > prevUpper ? bu : prevUpper;
      finalLower = bl > prevLower || pc < prevLower ? bl : prevLower;
      if (dir === 1 && c.close < finalLower) dir = -1;
      else if (dir === -1 && c.close > finalUpper) dir = 1;
    }
    direction[i] = dir;
    if (dir === 1) up[i] = finalLower; else down[i] = finalUpper;
  }
  return { up, down, direction };
}

// ---------------------------------------------------------------------------------------------------------------
// Registry: what each indicator is, its parameters and outputs. The UI, the AI tools and persistence all read this.
// ---------------------------------------------------------------------------------------------------------------

export const INDICATOR_TYPES = ['sma', 'ema', 'wma', 'rsi', 'macd', 'bollinger', 'atr', 'stochastic', 'vwap', 'supertrend'] as const;
export type IndicatorType = (typeof INDICATOR_TYPES)[number];

export type ParamValue = number | string;
export type ParamValues = Record<string, ParamValue>;

export type ParamDef =
  | { key: string; label: string; type: 'int' | 'float'; default: number; min: number; max: number; step?: number }
  | { key: string; label: string; type: 'select'; default: string; options: readonly string[] };

export interface OutputDef {
  key: string;
  label: string;
  kind: 'line' | 'histogram';
  color: string;
  /** Histogram only: colour of negative bars. */
  negColor?: string;
}

export interface IndicatorDef {
  type: IndicatorType;
  name: string;
  description: string;
  /** 'overlay' draws on the price pane; 'pane' gets its own pane under the chart. */
  placement: 'overlay' | 'pane';
  params: readonly ParamDef[];
  outputs: readonly OutputDef[];
  /** Pane indicators: fixed horizontal guide levels (e.g. RSI 30/70). */
  levels?: readonly number[];
  /** Pane indicators with a fixed scale. */
  range?: { min: number; max: number };
  /** True when the maths uses MT5 tick volume. */
  usesTickVolume?: boolean;
  compute(candles: readonly Candle[], params: ParamValues): Record<string, Series>;
}

const sourceParam: ParamDef = { key: 'source', label: 'Source', type: 'select', default: 'close', options: SOURCES };
const period = (def: number, key = 'period', label = 'Period', max = 500): ParamDef => ({ key, label, type: 'int', default: def, min: 1, max });
const num = (p: ParamValues, k: string) => Number(p[k]);
const src = (c: readonly Candle[], p: ParamValues) => sourceSeries(c, (p.source as IndicatorSource) ?? 'close');

export const INDICATORS: Record<IndicatorType, IndicatorDef> = {
  sma: {
    type: 'sma', name: 'SMA', description: 'Simple moving average.', placement: 'overlay',
    params: [period(20), sourceParam], outputs: [{ key: 'value', label: 'SMA', kind: 'line', color: '#d4af5a' }],
    compute: (c, p) => ({ value: sma(src(c, p), num(p, 'period')) }),
  },
  ema: {
    type: 'ema', name: 'EMA', description: 'Exponential moving average (seeded with an SMA).', placement: 'overlay',
    params: [period(20), sourceParam], outputs: [{ key: 'value', label: 'EMA', kind: 'line', color: '#7fa8f5' }],
    compute: (c, p) => ({ value: ema(src(c, p), num(p, 'period')) }),
  },
  wma: {
    type: 'wma', name: 'WMA', description: 'Linearly weighted moving average.', placement: 'overlay',
    params: [period(20), sourceParam], outputs: [{ key: 'value', label: 'WMA', kind: 'line', color: '#c792ea' }],
    compute: (c, p) => ({ value: wma(src(c, p), num(p, 'period')) }),
  },
  rsi: {
    type: 'rsi', name: 'RSI', description: 'Relative Strength Index (Wilder smoothing), 0 to 100.', placement: 'pane',
    params: [period(14), sourceParam], outputs: [{ key: 'value', label: 'RSI', kind: 'line', color: '#c792ea' }],
    levels: [30, 50, 70], range: { min: 0, max: 100 },
    compute: (c, p) => ({ value: rsi(src(c, p), num(p, 'period')) }),
  },
  macd: {
    type: 'macd', name: 'MACD', description: 'Moving Average Convergence Divergence: fast EMA minus slow EMA, signal line and histogram.', placement: 'pane',
    params: [period(12, 'fast', 'Fast period'), period(26, 'slow', 'Slow period'), period(9, 'signal', 'Signal period'), sourceParam],
    outputs: [
      { key: 'macd', label: 'MACD', kind: 'line', color: '#7fa8f5' },
      { key: 'signal', label: 'Signal', kind: 'line', color: '#e8903c' },
      { key: 'histogram', label: 'Histogram', kind: 'histogram', color: '#2ebd85', negColor: '#f0616d' },
    ],
    levels: [0],
    compute: (c, p) => ({ ...macd(src(c, p), num(p, 'fast'), num(p, 'slow'), num(p, 'signal')) }),
  },
  bollinger: {
    type: 'bollinger', name: 'Bollinger Bands', description: 'SMA with bands at a multiple of the standard deviation.', placement: 'overlay',
    params: [period(20), { key: 'mult', label: 'Std dev multiplier', type: 'float', default: 2, min: 0.1, max: 10, step: 0.1 }, sourceParam],
    outputs: [
      { key: 'upper', label: 'Upper', kind: 'line', color: '#7fa8f5' },
      { key: 'middle', label: 'Middle', kind: 'line', color: '#a3abb5' },
      { key: 'lower', label: 'Lower', kind: 'line', color: '#7fa8f5' },
    ],
    compute: (c, p) => ({ ...bollinger(src(c, p), num(p, 'period'), num(p, 'mult')) }),
  },
  atr: {
    type: 'atr', name: 'ATR', description: 'Average True Range (Wilder), in price units.', placement: 'pane',
    params: [period(14)], outputs: [{ key: 'value', label: 'ATR', kind: 'line', color: '#e8903c' }],
    compute: (c, p) => ({ value: atr(c, num(p, 'period')) }),
  },
  stochastic: {
    type: 'stochastic', name: 'Stochastic', description: 'Stochastic oscillator (%K smoothed, %D), 0 to 100.', placement: 'pane',
    params: [period(14, 'kPeriod', '%K period'), period(3, 'smoothK', '%K smoothing', 50), period(3, 'dPeriod', '%D period', 50)],
    outputs: [
      { key: 'k', label: '%K', kind: 'line', color: '#7fa8f5' },
      { key: 'd', label: '%D', kind: 'line', color: '#e8903c' },
    ],
    levels: [20, 80], range: { min: 0, max: 100 },
    compute: (c, p) => ({ ...stochastic(c, num(p, 'kPeriod'), num(p, 'smoothK'), num(p, 'dPeriod')) }),
  },
  vwap: {
    type: 'vwap', name: 'VWAP (tick volume)', description: 'Session VWAP weighted by MT5 TICK volume, not exchange volume. Restarts each broker-time session.', placement: 'overlay',
    params: [{ key: 'sessionStartHour', label: 'Session start (broker hour)', type: 'int', default: 0, min: 0, max: 23 }],
    outputs: [{ key: 'value', label: 'VWAP', kind: 'line', color: '#2ebd85' }],
    usesTickVolume: true,
    compute: (c, p) => ({ value: vwap(c, num(p, 'sessionStartHour')) }),
  },
  supertrend: {
    type: 'supertrend', name: 'Supertrend', description: 'ATR-band trend follower. Green line below price in an uptrend, red above in a downtrend.', placement: 'overlay',
    params: [period(10), { key: 'mult', label: 'ATR multiplier', type: 'float', default: 3, min: 0.1, max: 20, step: 0.1 }],
    outputs: [
      { key: 'up', label: 'Uptrend', kind: 'line', color: '#2ebd85' },
      { key: 'down', label: 'Downtrend', kind: 'line', color: '#f0616d' },
    ],
    compute: (c, p) => { const { up, down } = supertrend(c, num(p, 'period'), num(p, 'mult')); return { up, down }; },
  },
};

export const isIndicatorType = (t: string): t is IndicatorType => (INDICATOR_TYPES as readonly string[]).includes(t);

export function defaultParams(type: IndicatorType): ParamValues {
  return Object.fromEntries(INDICATORS[type].params.map((p) => [p.key, p.default]));
}

export type ParamResult = { ok: true; params: ParamValues } | { ok: false; error: string };

/** Fill defaults for missing params and reject unknown keys, wrong types and out-of-range values. */
export function resolveParams(type: IndicatorType, input: Record<string, unknown> = {}): ParamResult {
  const def = INDICATORS[type];
  const out: ParamValues = defaultParams(type);
  for (const [k, v] of Object.entries(input)) {
    const p = def.params.find((x) => x.key === k);
    if (!p) return { ok: false, error: `${def.name} has no parameter '${k}'. Valid: ${def.params.map((x) => x.key).join(', ')}.` };
    if (p.type === 'select') {
      if (typeof v !== 'string' || !p.options.includes(v)) return { ok: false, error: `${p.label} must be one of ${p.options.join(', ')}.` };
      out[k] = v;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${p.label} must be a number.` };
      if (p.type === 'int' && !Number.isInteger(v)) return { ok: false, error: `${p.label} must be a whole number.` };
      if (v < p.min || v > p.max) return { ok: false, error: `${p.label} must be between ${p.min} and ${p.max}.` };
      out[k] = v;
    }
  }
  if (type === 'macd' && num(out, 'fast') >= num(out, 'slow')) return { ok: false, error: 'MACD fast period must be smaller than the slow period.' };
  return { ok: true, params: out };
}

/** Compute every output of an indicator on real candles. Output arrays match `candles` in length (NaN = undefined). */
export function computeIndicator(type: IndicatorType, candles: readonly Candle[], params: ParamValues): Record<string, Series> {
  const r = resolveParams(type, params);
  if (!r.ok) throw new Error(r.error);
  return INDICATORS[type].compute(candles, r.params);
}

/** Number of candles the indicator needs before its first defined value (rough guide for the UI/AI). */
export function warmupBars(type: IndicatorType, params: ParamValues): number {
  const n = (k: string) => Number(params[k]);
  switch (type) {
    case 'macd': return n('slow') + n('signal') - 1;
    case 'rsi': return n('period') + 1;
    case 'stochastic': return n('kPeriod') + n('smoothK') + n('dPeriod') - 2;
    case 'vwap': return 1;
    case 'supertrend': return n('period');
    default: return n('period');
  }
}

/** Last `count` rows of every output as [time, ...values], skipping rows where every output is NaN. */
export function tailValues(candles: readonly Candle[], series: Record<string, Series>, keys: readonly string[], count: number) {
  const rows: (number | null)[][] = [];
  for (let i = candles.length - 1; i >= 0 && rows.length < count; i--) {
    const vals = keys.map((k) => { const v = series[k]?.[i]; return v !== undefined && isNum(v) ? v : null; });
    if (vals.every((v) => v === null)) continue;
    rows.push([candles[i]!.time, ...vals]);
  }
  return rows.reverse();
}
