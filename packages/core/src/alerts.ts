import { z } from 'zod';
import { TIMEFRAME_SECONDS, TimeframeSchema, barStart, type Candle, type FeedStatus, type Tick, type Timeframe } from './feed';
import type { Drawing } from './drawing';
import { addDays, isValidTimeZone, isWeekday, localParts, parseHHMM, zonedTimeToUtc, type Ymd } from './timezone';

/**
 * Deterministic local alert engine. Pure: `evaluateAlert(alert, snapshot, state)` returns whether to fire, why, the exact
 * values it used and the next state. No clock, no I/O, no LLM. The host (AlertMonitor) owns the state and persists it.
 *
 * Semantics worth knowing:
 *  - Crossings are detected between consecutive samples via remembered side/position, never by level equality.
 *  - The first sample after arming, restarting or a feed outage only records the position and never fires.
 *  - A market-closed gap (feed "stale", no new ticks) keeps the position, so a weekend gap through a level fires on the
 *    first tick of the new week. A feed outage (disconnected/error) or an app restart forgets the position instead.
 *  - Time events (schedule/session) fire once per occurrence; an occurrence older than the grace window is reported as
 *    missed and never fires late.
 */

// ---------- sessions ----------

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 hour)');
const TimeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'Unknown IANA time zone');

export const SESSION_NAMES = ['sydney', 'tokyo', 'london', 'newyork'] as const;
export const SessionNameSchema = z.enum(SESSION_NAMES);
export type SessionName = z.infer<typeof SessionNameSchema>;

/** Local opening hours in an IANA zone, so daylight-saving changes move the UTC hours automatically. Use tz "UTC" for fixed UTC hours. */
export const SessionHoursSchema = z.object({ tz: TimeZoneSchema, open: HHMM, close: HHMM });
export type SessionHours = z.infer<typeof SessionHoursSchema>;
export type SessionTable = Record<SessionName, SessionHours>;

/** Defaults are local business hours of each financial centre. All editable per alert and in the UI. */
export const DEFAULT_SESSIONS: SessionTable = {
  sydney: { tz: 'Australia/Sydney', open: '07:00', close: '16:00' },
  tokyo: { tz: 'Asia/Tokyo', open: '09:00', close: '18:00' },
  london: { tz: 'Europe/London', open: '08:00', close: '17:00' },
  newyork: { tz: 'America/New_York', open: '08:00', close: '17:00' },
};
export const SESSION_LABEL: Record<SessionName, string> = { sydney: 'Sydney', tokyo: 'Tokyo', london: 'London', newyork: 'New York' };

// ---------- conditions ----------

const Price = z.number().positive().finite();
const PriceSourceSchema = z.enum(['bid', 'ask', 'mid']);
export type PriceSource = z.infer<typeof PriceSourceSchema>;
const DrawingTarget = z.object({ kind: z.literal('drawing'), drawingId: z.string().min(1) });
const RangeTarget = z.object({ kind: z.literal('range'), low: Price, high: Price })
  .refine((r) => r.high > r.low, { message: 'Zone high must be above low' });

export const AlertConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price_cross'), direction: z.enum(['above', 'below']), level: Price, source: PriceSourceSchema.default('bid') }),
  z.object({ type: z.literal('zone'), event: z.enum(['touch', 'enter', 'exit']), target: z.union([DrawingTarget, RangeTarget]), source: PriceSourceSchema.default('bid') }),
  z.object({ type: z.literal('trendline'), drawingId: z.string().min(1), tolerance: z.number().min(0).max(1000).default(0), source: PriceSourceSchema.default('bid') }),
  z.object({ type: z.literal('candle_close'), timeframe: TimeframeSchema, direction: z.enum(['above', 'below']), level: Price }),
  z.object({ type: z.literal('spread'), threshold: z.number().positive().finite() }),
  z.object({ type: z.literal('feed'), state: z.enum(['stale', 'disconnected', 'either']) }),
  z.object({ type: z.literal('position_plan'), drawingId: z.string().min(1), event: z.enum(['entry', 'sl', 'tp']), tpIndex: z.number().int().min(1).max(5).optional() }),
  z.object({ type: z.literal('session'), session: SessionNameSchema, event: z.enum(['open', 'close']), hours: SessionHoursSchema.optional() }),
  z.object({
    type: z.literal('schedule'),
    when: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }),
      z.object({ kind: z.literal('daily'), time: HHMM, tz: TimeZoneSchema, weekdaysOnly: z.boolean().default(false) }),
    ]),
  }),
]).superRefine((c, ctx) => {
  if (c.type === 'position_plan' && c.event === 'tp' && c.tpIndex === undefined) {
    ctx.addIssue({ code: 'custom', message: 'tpIndex (1-5) is required for a take-profit alert', path: ['tpIndex'] });
  }
});
export type AlertCondition = z.infer<typeof AlertConditionSchema>;
export type ConditionType = AlertCondition['type'];
/** Condition kinds that are driven by clock time rather than price. */
export const TIME_CONDITIONS: ConditionType[] = ['session', 'schedule'];

export const RepeatSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('once') }),
  z.object({ mode: z.literal('every'), cooldownSec: z.number().int().min(0).max(7 * 86400) }),
  z.object({ mode: z.literal('per_bar'), timeframe: TimeframeSchema }),
]);
export type Repeat = z.infer<typeof RepeatSchema>;

export const ChannelsSchema = z.object({
  desktop: z.boolean().default(true),
  /** Only a flag: the WhatsApp gateway reads it. Nothing in this module sends WhatsApp. */
  whatsapp: z.boolean().default(false),
  sound: z.boolean().default(false),
});
export type Channels = z.infer<typeof ChannelsSchema>;

export const SeveritySchema = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;
export const AlertActorSchema = z.enum(['manual', 'ai', 'whatsapp', 'rule']);
export type AlertActor = z.infer<typeof AlertActorSchema>;

export const AlertSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  condition: AlertConditionSchema,
  repeat: RepeatSchema,
  /** Unix ms after which the alert stops firing. */
  expiresAt: z.number().int().nullable(),
  channels: ChannelsSchema,
  /** Template with {name} {price} {level} {reason} {time} {symbol}; empty = the generated reason. */
  message: z.string().max(500),
  severity: SeveritySchema,
  origin: z.object({ by: AlertActorSchema, at: z.number(), commandId: z.string().optional(), reason: z.string().max(500).optional() }),
  createdAt: z.number().int(),
  /** Set on create, on enabling, and whenever the condition/repeat/expiry changes: the baseline for "no fire on first sample". */
  armedAt: z.number().int(),
});
export type Alert = z.infer<typeof AlertSchema>;

// ---------- runtime state (persisted by the host so "already fired" survives a restart) ----------

export const AlertStateSchema = z.object({
  armedAt: z.number(),
  done: z.boolean().default(false),
  fireCount: z.number().int().default(0),
  lastFiredAt: z.number().nullable().default(null),
  lastFiredBar: z.number().nullable().default(null),
  /** Last non-zero side of price relative to a level (-1 below, 1 above). */
  side: z.union([z.literal(-1), z.literal(1)]).nullable().default(null),
  /** Last position of price relative to a band. */
  pos: z.enum(['below', 'inside', 'above']).nullable().default(null),
  /** Identity of the level/band the position refers to; a changed level restarts from "first sample". */
  refKey: z.string().nullable().default(null),
  /** Last truth value of a state condition (spread/feed). */
  flag: z.boolean().nullable().default(null),
  lastCandleTime: z.number().nullable().default(null),
  lastOccurrence: z.number().nullable().default(null),
});
export type AlertState = z.infer<typeof AlertStateSchema>;

export const freshState = (armedAt: number): AlertState => AlertStateSchema.parse({ armedAt });

/** After an app restart the remembered price position is stale; "already fired" and schedule progress are kept. */
export function forgetSamples(s: AlertState): AlertState {
  return { ...s, side: null, pos: null, refKey: null, flag: null, lastCandleTime: null };
}

export interface AlertSnapshot {
  tick: Tick | null;
  /** CLOSED candles per timeframe, oldest first. The engine also drops any candle that has not closed by tick time. */
  lastClosedCandlesByTf: Partial<Record<Timeframe, Candle[]>>;
  drawings: Drawing[];
  /** Real UTC ms. */
  now: number;
  feedStatus: FeedStatus;
  sessions?: Partial<SessionTable>;
}

export type EvalStatus = 'ok' | 'disabled' | 'expired' | 'done' | 'waiting' | 'invalid' | 'missed';
export type EvalValues = Record<string, string | number | boolean | null>;
export interface EvalOutcome {
  fire: boolean;
  status: EvalStatus;
  /** Human sentence. When fire is true this is what happened; otherwise why nothing fired. */
  reason: string;
  /** The exact numbers used for this decision. */
  values: EvalValues;
  state: AlertState;
}

/** A time event that was due but older than the grace window (app was closed). Reported, never fired late. */
export const LATE_GRACE_MS = 5 * 60_000;

// ---------- helpers ----------

const fmt = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : String(n));
const sign = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0);
const iso = (ms: number) => new Date(ms).toISOString();

export function priceFrom(tick: Tick, source: PriceSource): number {
  return source === 'ask' ? tick.ask : source === 'mid' ? (tick.ask + tick.bid) / 2 : tick.bid;
}

/** Price of a straight drawing at chart time `t` (broker clock, unix s); null when the line does not exist at that time. */
export function linePriceAt(d: Drawing, t: number): number | null {
  if (d.kind === 'hline') return d.price;
  if (d.kind !== 'trendline' && d.kind !== 'ray') return null;
  const { a, b } = d;
  if (a.time === b.time) return null;
  const lo = Math.min(a.time, b.time);
  const hi = Math.max(a.time, b.time);
  if (d.kind === 'ray') { if (t < a.time) return null; }
  else if (d.extend === 'none' && (t < lo || t > hi)) return null;
  else if (d.extend === 'right' && t < lo) return null;
  else if (d.extend === 'both') { /* any time */ }
  return a.price + ((b.price - a.price) * (t - a.time)) / (b.time - a.time);
}

export function zoneBounds(d: Drawing): { low: number; high: number } | null {
  if (d.kind !== 'zone') return null;
  return { low: Math.min(d.a.price, d.b.price), high: Math.max(d.a.price, d.b.price) };
}

const feedIsLive = (f: FeedStatus) => f.state === 'connected' || f.state === 'stale';

// ---------- time events ----------

export interface Occurrences { latest: number | null; next: number | null }

function dayOf(ms: number, tz: string): Ymd {
  const p = localParts(ms, tz);
  return { y: p.y, m: p.m, d: p.d };
}

function dailyAt(date: Ymd, time: string, tz: string): number {
  const { hh, mm } = parseHHMM(time);
  return zonedTimeToUtc(date.y, date.m, date.d, hh, mm, tz);
}

/** Closest event instants around `now`. Weekend session events are skipped (Mon-Fri in the session's own zone). Exchange holidays are not modelled. */
export function eventOccurrences(c: Extract<AlertCondition, { type: 'session' | 'schedule' }>, now: number, sessions: Partial<SessionTable> = {}): Occurrences {
  if (c.type === 'schedule' && c.when.kind === 'once') {
    const at = Date.parse(c.when.at);
    return { latest: at <= now ? at : null, next: at > now ? at : null };
  }
  let tz: string;
  let at: (date: Ymd) => number;
  let eligible: (date: Ymd) => boolean;
  if (c.type === 'schedule' && c.when.kind === 'daily') {
    const w = c.when;
    tz = w.tz;
    at = (date) => dailyAt(date, w.time, w.tz);
    eligible = (date) => !w.weekdaysOnly || isWeekday(date);
  } else if (c.type === 'session') {
    const h = c.hours ?? sessions[c.session] ?? DEFAULT_SESSIONS[c.session];
    tz = h.tz;
    const crosses = h.close <= h.open;
    at = (date) => (c.event === 'open' ? dailyAt(date, h.open, h.tz) : dailyAt(crosses ? addDays(date, 1) : date, h.close, h.tz));
    eligible = isWeekday;
  } else {
    return { latest: null, next: null };
  }
  const today = dayOf(now, tz);
  let latest: number | null = null;
  let next: number | null = null;
  for (let i = 0; i <= 8 && latest === null; i++) {
    const date = addDays(today, -i);
    if (!eligible(date)) continue;
    const t = at(date);
    if (t <= now) latest = t;
  }
  // Start from yesterday so a session that closes after local midnight is still found.
  for (let i = -1; i <= 8 && next === null; i++) {
    const date = addDays(today, i);
    if (!eligible(date)) continue;
    const t = at(date);
    if (t > now) next = t;
  }
  return { latest, next };
}

// ---------- condition evaluation ----------

interface Hit { reason: string; values: EvalValues }
interface Probe { hit?: Hit; status?: EvalStatus; note: string; values: EvalValues; /** consume the hit but never report it */ missed?: boolean }

const wait = (note: string, values: EvalValues = {}): Probe => ({ status: 'waiting', note, values });
const invalid = (note: string): Probe => ({ status: 'invalid', note, values: {} });

/** Side-based crossing of one level. Returns a hit when the price reached/passed `level` in `direction` since the last sample. */
function crossLevel(st: AlertState, refKey: string, level: number, price: number, direction: 'above' | 'below', label: string, values: EvalValues): Probe {
  if (st.refKey !== refKey) { st.refKey = refKey; st.side = null; }
  const s = sign(price - level);
  const prior = st.side;
  const hit = direction === 'above' ? prior === -1 && s >= 0 : prior === 1 && s <= 0;
  if (hit) st.side = direction === 'above' ? 1 : -1;
  else if (s !== 0) st.side = s;
  const v: EvalValues = { ...values, price, level, previousSide: prior === null ? null : prior === 1 ? 'above' : 'below' };
  if (hit) {
    return { hit: { reason: `${label} ${fmt(price)} crossed ${direction} ${fmt(level)}`, values: v }, note: '', values: v };
  }
  const note = prior === null
    ? `First sample recorded: ${label} ${fmt(price)} vs ${fmt(level)}. Nothing fires until it crosses ${direction}.`
    : `${label} ${fmt(price)} is ${s > 0 ? 'above' : s < 0 ? 'below' : 'at'} ${fmt(level)}; waiting for a cross ${direction}.`;
  return { note, values: v };
}

/** Band logic shared by zone events and trendline touches. */
function bandEvent(st: AlertState, refKey: string, low: number, high: number, price: number, event: 'touch' | 'enter' | 'exit', label: string, values: EvalValues): Probe {
  if (st.refKey !== refKey) { st.refKey = refKey; st.pos = null; }
  const pos = price < low ? 'below' : price > high ? 'above' : 'inside';
  const prior = st.pos;
  st.pos = pos;
  const v: EvalValues = { ...values, price, low, high, position: pos, previousPosition: prior };
  if (prior === null) return { note: `First sample recorded: ${label} ${fmt(price)} is ${pos} ${fmt(low)}-${fmt(high)}.`, values: v };
  const entered = prior !== 'inside' && pos === 'inside';
  const exited = prior === 'inside' && pos !== 'inside';
  const jumped = (prior === 'below' && pos === 'above') || (prior === 'above' && pos === 'below');
  const hit = event === 'enter' ? entered : event === 'exit' ? exited : entered || jumped;
  if (hit) {
    const what = event === 'exit' ? 'left' : jumped ? 'jumped through' : event === 'enter' ? 'entered' : 'touched';
    return { hit: { reason: `${label} ${fmt(price)} ${what} the band ${fmt(low)}-${fmt(high)}${jumped ? ' (gap through)' : ''}`, values: v }, note: '', values: v };
  }
  return { note: `${label} ${fmt(price)} is ${pos} ${fmt(low)}-${fmt(high)}; waiting for ${event}.`, values: v };
}

function evalCondition(alert: Alert, snap: AlertSnapshot, st: AlertState): Probe {
  const c = alert.condition;
  const live = feedIsLive(snap.feedStatus);
  const tick = snap.tick;

  switch (c.type) {
    case 'price_cross': {
      if (!live || !tick) return forgetPrice(st, `Feed is ${snap.feedStatus.state}; no price to compare.`);
      return crossLevel(st, `lvl:${c.level}`, c.level, priceFrom(tick, c.source), c.direction, c.source, { source: c.source, tickTime: tick.time });
    }
    case 'zone': {
      if (!live || !tick) return forgetPrice(st, `Feed is ${snap.feedStatus.state}; no price to compare.`);
      let low: number;
      let high: number;
      if (c.target.kind === 'range') { low = c.target.low; high = c.target.high; }
      else {
        const d = snap.drawings.find((x) => x.id === (c.target as { drawingId: string }).drawingId);
        if (!d) return invalid('The zone drawing no longer exists.');
        const b = zoneBounds(d);
        if (!b) return invalid(`Drawing is a ${d.kind}, not a zone.`);
        low = b.low; high = b.high;
      }
      return bandEvent(st, `zone:${low}:${high}`, low, high, priceFrom(tick, c.source), c.event, c.source, { source: c.source, tickTime: tick.time });
    }
    case 'trendline': {
      if (!live || !tick) return forgetPrice(st, `Feed is ${snap.feedStatus.state}; no price to compare.`);
      const d = snap.drawings.find((x) => x.id === c.drawingId);
      if (!d) return invalid('The line drawing no longer exists.');
      if (d.kind !== 'trendline' && d.kind !== 'ray' && d.kind !== 'hline') return invalid(`Drawing is a ${d.kind}, not a line.`);
      const line = linePriceAt(d, tick.time);
      const key = d.kind === 'hline' ? `h:${d.price}` : `l:${d.a.time}:${d.a.price}:${d.b.time}:${d.b.price}:${d.kind === 'trendline' ? d.extend : 'ray'}`;
      if (line === null) { st.pos = null; return wait('The line does not extend to the current time.', { tickTime: tick.time }); }
      const tol = c.tolerance;
      return bandEvent(st, key, line - tol, line + tol, priceFrom(tick, c.source), 'touch', c.source, { source: c.source, lineAtNow: line, tolerance: tol, tickTime: tick.time });
    }
    case 'position_plan': {
      if (!live || !tick) return forgetPrice(st, `Feed is ${snap.feedStatus.state}; no price to compare.`);
      const d = snap.drawings.find((x) => x.id === c.drawingId);
      if (!d) return invalid('The position drawing no longer exists.');
      if (d.kind !== 'position') return invalid(`Drawing is a ${d.kind}, not a position.`);
      const buy = d.side === 'buy';
      // Entry fills at ask for buys / bid for sells; exits (SL/TP) are hit on the opposite side.
      const entrySrc: PriceSource = buy ? 'ask' : 'bid';
      const exitSrc: PriceSource = buy ? 'bid' : 'ask';
      if (c.event === 'entry') {
        return bandEvent(st, `entry:${d.entry}`, d.entry, d.entry, priceFrom(tick, entrySrc), 'touch', `${entrySrc} (entry)`, { source: entrySrc, level: d.entry, plan: d.side });
      }
      if (c.event === 'sl') {
        return crossLevel(st, `sl:${d.stopLoss}`, d.stopLoss, priceFrom(tick, exitSrc), buy ? 'below' : 'above', `${exitSrc} (stop loss)`, { source: exitSrc, plan: d.side });
      }
      const tp = d.takeProfits[(c.tpIndex ?? 1) - 1];
      if (!tp) return invalid(`The position has no TP${c.tpIndex}.`);
      return crossLevel(st, `tp${c.tpIndex}:${tp.price}`, tp.price, priceFrom(tick, exitSrc), buy ? 'above' : 'below', `${exitSrc} (TP${c.tpIndex})`, { source: exitSrc, plan: d.side, tpIndex: c.tpIndex ?? 1 });
    }
    case 'candle_close': {
      const sec = TIMEFRAME_SECONDS[c.timeframe];
      const all = snap.lastClosedCandlesByTf[c.timeframe];
      if (!all?.length) return wait(`No closed ${c.timeframe} candles from the feed yet.`);
      const closed = tick ? all.filter((k) => k.time + sec <= tick.time) : all;
      const newest = closed[closed.length - 1];
      if (!newest) return wait(`No closed ${c.timeframe} candle yet.`);
      const prior = st.lastCandleTime;
      st.lastCandleTime = newest.time;
      const base: EvalValues = { timeframe: c.timeframe, level: c.level, candleTime: newest.time, close: newest.close };
      if (prior === null) return { note: `First sample recorded: last closed ${c.timeframe} candle closed at ${fmt(newest.close)}.`, values: base };
      const fresh = closed.filter((k) => k.time > prior);
      const ok = (k: Candle) => (c.direction === 'above' ? k.close > c.level : k.close < c.level);
      const match = fresh.find(ok);
      if (match) {
        const v = { ...base, candleTime: match.time, close: match.close };
        return { hit: { reason: `${c.timeframe} candle (${iso(match.time * 1000)}) closed ${fmt(match.close)}, ${c.direction} ${fmt(c.level)}`, values: v }, note: '', values: v };
      }
      return { note: `${fresh.length ? `${fresh.length} new ${c.timeframe} candle(s) did not close ${c.direction} ${fmt(c.level)}` : `No new ${c.timeframe} candle since ${iso(prior * 1000)}`}.`, values: base };
    }
    case 'spread': {
      if (!live || !tick) { st.flag = null; return wait(`Feed is ${snap.feedStatus.state}; no spread available.`); }
      const above = tick.spread > c.threshold;
      const prior = st.flag;
      st.flag = above;
      const v: EvalValues = { spread: tick.spread, threshold: c.threshold, tickTime: tick.time };
      if (prior === null) return { note: `First sample recorded: spread ${fmt(tick.spread)} vs limit ${fmt(c.threshold)}.`, values: v };
      if (above && !prior) return { hit: { reason: `Spread ${fmt(tick.spread)} rose above ${fmt(c.threshold)}`, values: v }, note: '', values: v };
      return { note: `Spread ${fmt(tick.spread)} is ${above ? 'still above' : 'within'} ${fmt(c.threshold)}.`, values: v };
    }
    case 'feed': {
      const s = snap.feedStatus.state;
      const matches = c.state === 'stale' ? s === 'stale' : c.state === 'disconnected' ? s === 'disconnected' || s === 'error' : s === 'stale' || s === 'disconnected' || s === 'error';
      const prior = st.flag;
      st.flag = matches;
      const v: EvalValues = { feedState: s, feedMessage: snap.feedStatus.message ?? null };
      if (prior === null) return { note: `First sample recorded: feed is ${s}.`, values: v };
      if (matches && !prior) return { hit: { reason: `Feed is ${s}${snap.feedStatus.message ? `: ${snap.feedStatus.message}` : ''}`, values: v }, note: '', values: v };
      return { note: `Feed is ${s}.`, values: v };
    }
    case 'session':
    case 'schedule': {
      const occ = eventOccurrences(c, snap.now, snap.sessions);
      const baseline = Math.max(st.lastOccurrence ?? 0, st.armedAt);
      const v: EvalValues = { latest: occ.latest === null ? null : iso(occ.latest), next: occ.next === null ? null : iso(occ.next) };
      const waitNote = `Next ${c.type === 'session' ? `${SESSION_LABEL[c.session]} ${c.event}` : 'run'}: ${occ.next ? iso(occ.next) : 'none'}.`;
      if (occ.latest === null || occ.latest <= baseline) return { note: waitNote, values: v };
      st.lastOccurrence = occ.latest;
      const late = snap.now - occ.latest;
      if (late > LATE_GRACE_MS) {
        return { status: 'missed', missed: true, note: `Missed ${iso(occ.latest)} (${Math.round(late / 60000)} min late, app was not running).`, values: { ...v, occurrence: iso(occ.latest), lateMs: late } };
      }
      const what = c.type === 'session' ? `${SESSION_LABEL[c.session]} session ${c.event}` : c.when.kind === 'once' ? 'Scheduled time reached' : `Daily ${c.when.time} (${c.when.tz})`;
      return { hit: { reason: `${what} at ${iso(occ.latest)}`, values: { ...v, occurrence: iso(occ.latest), lateMs: late } }, note: '', values: v };
    }
  }
}

function forgetPrice(st: AlertState, note: string): Probe {
  st.side = null; st.pos = null; st.refKey = null; st.flag = null;
  return wait(note);
}

// ---------- the evaluator ----------

/**
 * Decide whether `alert` fires for this snapshot. `state` is the alert's previous runtime state (or undefined for never evaluated).
 * Returns the next state; the input is not mutated.
 */
export function evaluateAlert(alert: Alert, snap: AlertSnapshot, state?: AlertState): EvalOutcome {
  let st: AlertState = state && state.armedAt === alert.armedAt ? { ...state } : freshState(alert.armedAt);
  const out = (o: Omit<EvalOutcome, 'state'>): EvalOutcome => ({ ...o, state: st });

  if (!alert.enabled) return out({ fire: false, status: 'disabled', reason: 'Alert is disabled.', values: {} });
  if (st.done) return out({ fire: false, status: 'done', reason: 'Already fired (fires once). Re-arm it to use it again.', values: {} });
  if (alert.expiresAt !== null && snap.now >= alert.expiresAt) {
    return out({ fire: false, status: 'expired', reason: `Expired at ${iso(alert.expiresAt)}.`, values: {} });
  }

  const p = evalCondition(alert, snap, st);
  if (p.status === 'invalid') return out({ fire: false, status: 'invalid', reason: p.note, values: p.values });
  if (!p.hit) return out({ fire: false, status: p.status ?? 'ok', reason: p.note, values: p.values });

  // The condition is met. Apply the repeat policy.
  const r = alert.repeat;
  const bar = r.mode === 'per_bar' ? barStart(Math.floor(snap.now / 1000), r.timeframe) : null;
  if (r.mode === 'every' && st.lastFiredAt !== null && snap.now - st.lastFiredAt < r.cooldownSec * 1000) {
    const left = Math.ceil((r.cooldownSec * 1000 - (snap.now - st.lastFiredAt)) / 1000);
    return out({ fire: false, status: 'ok', reason: `Suppressed by cooldown (${left}s left). Condition met: ${p.hit.reason}`, values: p.hit.values });
  }
  if (r.mode === 'per_bar' && st.lastFiredBar === bar) {
    return out({ fire: false, status: 'ok', reason: `Suppressed: already fired in this ${r.timeframe} bar. Condition met: ${p.hit.reason}`, values: p.hit.values });
  }
  st = {
    ...st, fireCount: st.fireCount + 1, lastFiredAt: snap.now, lastFiredBar: bar ?? st.lastFiredBar,
    done: r.mode === 'once' || (alert.condition.type === 'schedule' && alert.condition.when.kind === 'once'),
  };
  return out({ fire: true, status: 'ok', reason: p.hit.reason, values: p.hit.values });
}

// ---------- presentation helpers (pure, shared by UI, AI tools and notifications) ----------

const SOURCE_NOTE = (s: PriceSource) => (s === 'bid' ? '' : ` (${s})`);

export function describeCondition(c: AlertCondition): string {
  switch (c.type) {
    case 'price_cross': return `Price crosses ${c.direction} ${fmt(c.level)}${SOURCE_NOTE(c.source)}`;
    case 'zone': return `Price ${c.event === 'touch' ? 'touches' : c.event === 'enter' ? 'enters' : 'exits'} ${c.target.kind === 'range' ? `zone ${fmt(c.target.low)}-${fmt(c.target.high)}` : 'a zone drawing'}`;
    case 'trendline': return `Price touches a trendline${c.tolerance ? ` (±${fmt(c.tolerance)})` : ''}`;
    case 'candle_close': return `${c.timeframe} candle closes ${c.direction} ${fmt(c.level)}`;
    case 'spread': return `Spread above ${fmt(c.threshold)}`;
    case 'feed': return c.state === 'either' ? 'Feed stale or disconnected' : `Feed ${c.state}`;
    case 'position_plan': return c.event === 'entry' ? 'Position entry reached' : c.event === 'sl' ? 'Position stop loss reached' : `Position TP${c.tpIndex} reached`;
    case 'session': return `${SESSION_LABEL[c.session]} session ${c.event}`;
    case 'schedule': return c.when.kind === 'once' ? `At ${c.when.at}` : `Daily ${c.when.time} ${c.when.tz}${c.when.weekdaysOnly ? ' (Mon-Fri)' : ''}`;
  }
}

export function describeRepeat(r: Repeat): string {
  return r.mode === 'once' ? 'Once' : r.mode === 'every' ? (r.cooldownSec ? `Every time, ${r.cooldownSec}s cooldown` : 'Every time') : `Once per ${r.timeframe} bar`;
}

/** Fills {name} {price} {level} {reason} {time} {symbol}. Unknown placeholders are left as written. */
export function renderMessage(template: string, vars: Record<string, string | number | boolean | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

export const DEFAULT_SEVERITY: Record<ConditionType, Severity> = {
  price_cross: 'info', zone: 'info', trendline: 'info', candle_close: 'info', spread: 'warning', feed: 'warning',
  position_plan: 'warning', session: 'info', schedule: 'info',
};

export interface MakeAlertOptions {
  id?: string;
  name?: string;
  actor?: AlertActor;
  now?: number;
  commandId?: string;
  reason?: string;
  enabled?: boolean;
  repeat?: Repeat;
  expiresAt?: number | null;
  channels?: Partial<Channels>;
  message?: string;
  severity?: Severity;
}

export function defaultAlertName(c: AlertCondition): string {
  return describeCondition(c).slice(0, 80);
}

/** Build a complete, valid alert from a condition. Throws a ZodError when the condition is invalid. */
export function makeAlert(condition: AlertCondition | z.input<typeof AlertConditionSchema>, o: MakeAlertOptions = {}): Alert {
  const cond = AlertConditionSchema.parse(condition);
  const now = o.now ?? Date.now();
  return AlertSchema.parse({
    id: o.id ?? (globalThis.crypto?.randomUUID?.() ?? `a_${Math.random().toString(36).slice(2)}`),
    name: o.name?.trim() || defaultAlertName(cond),
    enabled: o.enabled ?? true,
    condition: cond,
    repeat: o.repeat ?? (cond.type === 'schedule' && cond.when.kind === 'once' ? { mode: 'once' } : TIME_CONDITIONS.includes(cond.type) ? { mode: 'every', cooldownSec: 0 } : { mode: 'once' }),
    expiresAt: o.expiresAt ?? null,
    channels: ChannelsSchema.parse(o.channels ?? {}),
    message: o.message ?? '',
    severity: o.severity ?? DEFAULT_SEVERITY[cond.type],
    origin: { by: o.actor ?? 'manual', at: now, commandId: o.commandId, reason: o.reason },
    createdAt: now,
    armedAt: now,
  });
}

/** Checks that referenced drawings exist and are the right kind. Returns an error sentence or null. */
export function referenceIssue(c: AlertCondition, drawings: readonly Drawing[]): string | null {
  const find = (id: string) => drawings.find((d) => d.id === id);
  if (c.type === 'zone' && c.target.kind === 'drawing') {
    const d = find(c.target.drawingId);
    return !d ? `Drawing ${c.target.drawingId} not found.` : d.kind !== 'zone' ? `Drawing ${d.id} is a ${d.kind}; a zone is needed.` : null;
  }
  if (c.type === 'trendline') {
    const d = find(c.drawingId);
    return !d ? `Drawing ${c.drawingId} not found.` : !['trendline', 'ray', 'hline'].includes(d.kind) ? `Drawing ${d.id} is a ${d.kind}; a trendline, ray or horizontal line is needed.` : null;
  }
  if (c.type === 'position_plan') {
    const d = find(c.drawingId);
    if (!d) return `Drawing ${c.drawingId} not found.`;
    if (d.kind !== 'position') return `Drawing ${d.id} is a ${d.kind}; a position is needed.`;
    if (c.event === 'tp' && !d.takeProfits[(c.tpIndex ?? 1) - 1]) return `The position has no TP${c.tpIndex}.`;
  }
  return null;
}

/**
 * "Alert when price touches this": the alert conditions that make sense for a drawing, first one is the default.
 * `price` is the current bid (used to pick above/below for a plain level), or null when unknown.
 */
export function alertDraftsForDrawing(d: Drawing, price: number | null): { label: string; condition: AlertCondition }[] {
  const dir = (level: number): 'above' | 'below' => (price !== null && level < price ? 'below' : 'above');
  switch (d.kind) {
    case 'hline': return [{ label: `Price crosses ${fmt(d.price)}`, condition: { type: 'price_cross', direction: dir(d.price), level: d.price, source: 'bid' } }];
    case 'zone': return (['touch', 'enter', 'exit'] as const).map((event) => ({ label: `Price ${event === 'touch' ? 'touches' : event === 'enter' ? 'enters' : 'exits'} the zone`, condition: { type: 'zone', event, target: { kind: 'drawing', drawingId: d.id }, source: 'bid' } }));
    case 'trendline':
    case 'ray': return [{ label: 'Price touches the line', condition: { type: 'trendline', drawingId: d.id, tolerance: 0, source: 'bid' } }];
    case 'position': return [
      { label: 'Entry reached', condition: { type: 'position_plan', drawingId: d.id, event: 'entry' } },
      { label: 'Stop loss reached', condition: { type: 'position_plan', drawingId: d.id, event: 'sl' } },
      ...d.takeProfits.map((_, i) => ({ label: `TP${i + 1} reached`, condition: { type: 'position_plan', drawingId: d.id, event: 'tp', tpIndex: i + 1 } as AlertCondition })),
    ];
    default: return [];
  }
}
