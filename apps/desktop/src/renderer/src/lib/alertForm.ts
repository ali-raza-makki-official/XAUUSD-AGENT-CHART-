import { AlertConditionSchema, systemTimeZone, type AlertCondition, type ConditionType, type SessionName, type Timeframe } from '@aurum/core';

/** Text-field state of the alert dialog. Pure helpers below turn it into a validated AlertCondition and back. */
export interface AlertForm {
  type: ConditionType;
  direction: 'above' | 'below';
  level: string;
  source: 'bid' | 'ask' | 'mid';
  zoneEvent: 'touch' | 'enter' | 'exit';
  zoneMode: 'drawing' | 'range';
  low: string;
  high: string;
  drawingId: string;
  tolerance: string;
  tf: Timeframe;
  threshold: string;
  feedState: 'stale' | 'disconnected' | 'either';
  planEvent: 'entry' | 'sl' | 'tp';
  tpIndex: string;
  session: SessionName;
  sessionEvent: 'open' | 'close';
  when: 'once' | 'daily';
  /** datetime-local value (browser local time) */
  at: string;
  time: string;
  tz: string;
  weekdaysOnly: boolean;
}

export const emptyForm = (price: number | null = null): AlertForm => ({
  type: 'price_cross', direction: 'above', level: price === null ? '' : price.toFixed(2), source: 'bid',
  zoneEvent: 'touch', zoneMode: 'drawing', low: '', high: '', drawingId: '', tolerance: '0', tf: 'M15', threshold: '',
  feedState: 'either', planEvent: 'entry', tpIndex: '1', session: 'london', sessionEvent: 'open',
  when: 'once', at: '', time: '08:00', tz: systemTimeZone(), weekdaysOnly: false,
});

const num = (s: string): number => (s.trim() === '' ? NaN : Number(s));

export function buildCondition(f: AlertForm): { ok: true; condition: AlertCondition } | { ok: false; error: string } {
  let raw: unknown;
  switch (f.type) {
    case 'price_cross': raw = { type: 'price_cross', direction: f.direction, level: num(f.level), source: f.source }; break;
    case 'zone':
      raw = { type: 'zone', event: f.zoneEvent, source: f.source, target: f.zoneMode === 'drawing' ? { kind: 'drawing', drawingId: f.drawingId } : { kind: 'range', low: num(f.low), high: num(f.high) } };
      break;
    case 'trendline': raw = { type: 'trendline', drawingId: f.drawingId, tolerance: num(f.tolerance), source: f.source }; break;
    case 'candle_close': raw = { type: 'candle_close', timeframe: f.tf, direction: f.direction, level: num(f.level) }; break;
    case 'spread': raw = { type: 'spread', threshold: num(f.threshold) }; break;
    case 'feed': raw = { type: 'feed', state: f.feedState }; break;
    case 'position_plan': raw = { type: 'position_plan', drawingId: f.drawingId, event: f.planEvent, ...(f.planEvent === 'tp' ? { tpIndex: num(f.tpIndex) } : {}) }; break;
    case 'session': raw = { type: 'session', session: f.session, event: f.sessionEvent }; break;
    case 'schedule': {
      if (f.when === 'once') {
        const t = f.at ? new Date(f.at) : null;
        if (!t || Number.isNaN(t.getTime())) return { ok: false, error: 'Pick the date and time.' };
        raw = { type: 'schedule', when: { kind: 'once', at: t.toISOString() } };
      } else raw = { type: 'schedule', when: { kind: 'daily', time: f.time, tz: f.tz.trim(), weekdaysOnly: f.weekdaysOnly } };
      break;
    }
  }
  const p = AlertConditionSchema.safeParse(raw);
  if (p.success) return { ok: true, condition: p.data };
  const issue = p.error.issues[0];
  const field = issue?.path.filter((x) => typeof x === 'string').slice(-1)[0];
  const msg = issue?.message ?? 'Invalid alert';
  return { ok: false, error: /Invalid input: expected number/i.test(msg) ? `Enter a number for ${field ?? 'the value'}.` : /too small|positive/i.test(msg) ? `${field ?? 'Value'} must be greater than zero.` : msg };
}

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function formFromCondition(c: AlertCondition, base: AlertForm = emptyForm()): AlertForm {
  const f: AlertForm = { ...base, type: c.type };
  switch (c.type) {
    case 'price_cross': return { ...f, direction: c.direction, level: String(c.level), source: c.source };
    case 'zone': return c.target.kind === 'drawing'
      ? { ...f, zoneEvent: c.event, zoneMode: 'drawing', drawingId: c.target.drawingId, source: c.source }
      : { ...f, zoneEvent: c.event, zoneMode: 'range', low: String(c.target.low), high: String(c.target.high), source: c.source };
    case 'trendline': return { ...f, drawingId: c.drawingId, tolerance: String(c.tolerance), source: c.source };
    case 'candle_close': return { ...f, tf: c.timeframe, direction: c.direction, level: String(c.level) };
    case 'spread': return { ...f, threshold: String(c.threshold) };
    case 'feed': return { ...f, feedState: c.state };
    case 'position_plan': return { ...f, drawingId: c.drawingId, planEvent: c.event, tpIndex: String(c.tpIndex ?? 1) };
    case 'session': return { ...f, session: c.session, sessionEvent: c.event };
    case 'schedule': return c.when.kind === 'once'
      ? { ...f, when: 'once', at: toLocalInput(c.when.at) }
      : { ...f, when: 'daily', time: c.when.time, tz: c.when.tz, weekdaysOnly: c.when.weekdaysOnly };
  }
}
