import { z } from 'zod';

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TimeframeSchema = z.enum(TIMEFRAMES);

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
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
  const s = TIMEFRAME_SECONDS[tf];
  return Math.floor(time / s) * s;
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
