import { z } from 'zod';

/** Every period MT5 itself offers (periods outside this list, such as 13m, 45m or a year, do not exist in MT5). */
export const TIMEFRAMES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30', 'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D1', 'W1', 'MN1'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TimeframeSchema = z.enum(TIMEFRAMES);

/** Nominal length of a bar. MN1 is 30 days here only for spacing; its real bars start on the 1st of each month (see barStart). */
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M1: 60, M2: 120, M3: 180, M4: 240, M5: 300, M6: 360, M10: 600, M12: 720, M15: 900, M20: 1200, M30: 1800,
  H1: 3600, H2: 7200, H3: 10800, H4: 14400, H6: 21600, H8: 28800, H12: 43200,
  D1: 86400, W1: 604800, MN1: 2592000,
};

export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  M1: '1 minute', M2: '2 minutes', M3: '3 minutes', M4: '4 minutes', M5: '5 minutes', M6: '6 minutes', M10: '10 minutes', M12: '12 minutes',
  M15: '15 minutes', M20: '20 minutes', M30: '30 minutes', H1: '1 hour', H2: '2 hours', H3: '3 hours', H4: '4 hours', H6: '6 hours',
  H8: '8 hours', H12: '12 hours', D1: '1 day', W1: '1 week', MN1: '1 month',
};

/** Unix seconds. For MT5 feeds this is broker server time, same as the MT5 terminal chart. */
export const CandleSchema = z.object({
  time: z.number().int(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().default(0),
});
export type Candle = z.infer<typeof CandleSchema>;

export const TickSchema = z.object({
  symbol: z.string(),
  bid: z.number(),
  ask: z.number(),
  /** Unix seconds (fractional allowed), same clock as candles. */
  time: z.number(),
  spread: z.number(),
});
export type Tick = z.infer<typeof TickSchema>;

export const AccountInfoSchema = z.object({
  login: z.number().int().nullable(),
  server: z.string(),
  currency: z.string(),
  demo: z.boolean(),
  name: z.string().nullish(),
  balance: z.number().optional(),
  equity: z.number().optional(),
});
export type AccountInfo = z.infer<typeof AccountInfoSchema>;

export const SymbolSpecSchema = z.object({
  symbol: z.string(),
  digits: z.number().int(),
  point: z.number(),
  contractSize: z.number(),
  tickSize: z.number(),
  tickValue: z.number(),
  volumeMin: z.number(),
  volumeMax: z.number(),
  volumeStep: z.number(),
});
export type SymbolSpec = z.infer<typeof SymbolSpecSchema>;

export const CandlesResponseSchema = z.object({
  symbol: z.string(),
  tf: TimeframeSchema,
  candles: z.array(CandleSchema),
});

export const HealthSchema = z.object({
  ok: z.boolean(),
  connected: z.boolean(),
  symbol: z.string(),
  error: z.string().nullable().optional(),
  version: z.string(),
});
export type BridgeHealth = z.infer<typeof HealthSchema>;

export type FeedState = 'starting' | 'connected' | 'stale' | 'disconnected' | 'error';

export interface FeedStatus {
  state: FeedState;
  message?: string;
}

/** Start time of the bar that contains `time` for a timeframe. */
export function barStart(time: number, tf: Timeframe): number {
  if (tf === 'MN1') { const d = new Date(time * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  const s = TIMEFRAME_SECONDS[tf];
  // MT5 weekly bars open on Sunday 00:00 server time; the Unix epoch (1970-01-01) was a Thursday, so shift by 4 days.
  if (tf === 'W1') { const shift = 4 * 86400; return Math.floor((time + shift) / s) * s - shift; }
  return Math.floor(time / s) * s;
}

/** Start of the bar after the one that begins at `start` (months differ in length). */
export function nextBarStart(start: number, tf: Timeframe): number {
  if (tf === 'MN1') { const d = new Date(start * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; }
  return start + TIMEFRAME_SECONDS[tf];
}

/** Fold a tick into the last candle (or open a new one) using the bid price. */
export function applyTick(candles: Candle[], tick: Tick, tf: Timeframe): Candle[] {
  const start = barStart(tick.time, tf);
  const last = candles[candles.length - 1];
  const p = tick.bid;
  if (!last || start > last.time) {
    return [...candles, { time: start, open: p, high: p, low: p, close: p, volume: 0 }];
  }
  if (start < last.time) return candles; // out-of-order tick for an older bar
  const updated: Candle = {
    ...last,
    high: Math.max(last.high, p),
    low: Math.min(last.low, p),
    close: p,
  };
  return [...candles.slice(0, -1), updated];
}

/** A tick older than this (seconds) marks the feed as stale. */
export const STALE_AFTER_SECONDS = 10;
