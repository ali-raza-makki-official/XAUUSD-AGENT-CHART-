import { describe, expect, it } from 'vitest';
import {
  evaluateAlert, forgetSamples, makeAlert, linePriceAt, eventOccurrences, describeCondition, renderMessage, referenceIssue, alertDraftsForDrawing, AlertSchema,
  makeDrawing, zonedTimeToUtc, tzOffsetMs, localParts, LATE_GRACE_MS,
  type Alert, type AlertCondition, type AlertSnapshot, type AlertState, type Candle, type Drawing, type FeedStatus, type Repeat, type Timeframe,
} from '../src';

const T0 = Date.parse('2026-10-21T10:00:00Z'); // a Wednesday
const connected: FeedStatus = { state: 'connected' };

function snap(bid: number, o: Partial<AlertSnapshot> & { spread?: number; tickTime?: number } = {}): AlertSnapshot {
  const now = o.now ?? T0;
  return {
    tick: o.tick === undefined ? { symbol: 'GOLD', bid, ask: bid + (o.spread ?? 0.2), time: o.tickTime ?? Math.floor(now / 1000), spread: o.spread ?? 0.2 } : o.tick,
    lastClosedCandlesByTf: o.lastClosedCandlesByTf ?? {}, drawings: o.drawings ?? [], now, feedStatus: o.feedStatus ?? connected, sessions: o.sessions,
  };
}
const mk = (condition: AlertCondition, extra: Parameters<typeof makeAlert>[1] = {}) => makeAlert(condition, { id: 'a1', now: T0 - 1000, ...extra });

/** Run a sequence of snapshots through the engine, carrying state like the monitor does. */
function run(alert: Alert, snaps: AlertSnapshot[], start?: AlertState) {
  let st = start;
  return snaps.map((s) => { const o = evaluateAlert(alert, s, st); st = o.state; return o; });
}
const fires = (os: { fire: boolean }[]) => os.map((o) => o.fire);

describe('time zone maths', () => {
  it('knows London offsets either side of DST', () => {
    expect(tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Europe/London')).toBe(3_600_000);
    expect(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
    expect(tzOffsetMs(Date.parse('2026-12-15T12:00:00Z'), 'Australia/Sydney')).toBe(11 * 3_600_000);
  });
  it('converts wall-clock time to UTC across a spring-forward and a fall-back', () => {
    expect(new Date(zonedTimeToUtc(2026, 3, 27, 8, 0, 'Europe/London')).toISOString()).toBe('2026-03-27T08:00:00.000Z');
    expect(new Date(zonedTimeToUtc(2026, 3, 30, 8, 0, 'Europe/London')).toISOString()).toBe('2026-03-30T07:00:00.000Z');
    // 01:30 does not exist on 2026-03-29 in London: shifted forward to 02:30 BST
    expect(new Date(zonedTimeToUtc(2026, 3, 29, 1, 30, 'Europe/London')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(localParts(zonedTimeToUtc(2026, 3, 29, 1, 30, 'Europe/London'), 'Europe/London').hh).toBe(2);
    // 01:30 happens twice on 2026-10-25: first occurrence (BST) wins
    expect(new Date(zonedTimeToUtc(2026, 10, 25, 1, 30, 'Europe/London')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('schema', () => {
  it('rejects bad zones, bad times and tp alerts without an index', () => {
    expect(() => mk({ type: 'zone', event: 'touch', target: { kind: 'range', low: 10, high: 5 }, source: 'bid' })).toThrow();
    expect(() => mk({ type: 'schedule', when: { kind: 'daily', time: '25:00', tz: 'UTC', weekdaysOnly: false } })).toThrow();
    expect(() => mk({ type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'Mars/Base', weekdaysOnly: false } })).toThrow();
    expect(() => mk({ type: 'position_plan', drawingId: 'p', event: 'tp' })).toThrow();
    expect(() => mk({ type: 'price_cross', direction: 'above', level: -1, source: 'bid' })).toThrow();
  });
  it('makeAlert fills safe defaults', () => {
    const a = mk({ type: 'price_cross', direction: 'above', level: 3350, source: 'bid' });
    expect(a.repeat).toEqual({ mode: 'once' });
    expect(a.channels).toEqual({ desktop: true, whatsapp: false, sound: false });
    expect(AlertSchema.safeParse(a).success).toBe(true);
    expect(a.name).toContain('3350');
  });
});

describe('price cross', () => {
  const above = mk({ type: 'price_cross', direction: 'above', level: 3350, source: 'bid' }, { repeat: { mode: 'every', cooldownSec: 0 } });

  it('never fires on the first sample, even when already beyond the level', () => {
    expect(fires(run(above, [snap(3360)]))).toEqual([false]);
    expect(fires(run(above, [snap(3360), snap(3361), snap(3362)]))).toEqual([false, false, false]);
  });

  it('fires exactly once when a tick crosses and not while price stays above', () => {
    const os = run(above, [snap(3349), snap(3349.5), snap(3350.5), snap(3351), snap(3352)]);
    expect(fires(os)).toEqual([false, false, true, false, false]);
    expect(os[2]!.reason).toMatch(/crossed above 3350/);
    expect(os[2]!.values).toMatchObject({ price: 3350.5, level: 3350, previousSide: 'below' });
  });

  it('is edge detection, not equality: a tick exactly on the level counts once as reaching it', () => {
    const os = run(above, [snap(3349), snap(3350), snap(3350), snap(3350.1)]);
    expect(fires(os)).toEqual([false, true, false, false]);
  });

  it('re-arms after price falls back below and fires on the next cross', () => {
    const os = run(above, [snap(3349), snap(3351), snap(3349), snap(3351)]);
    expect(fires(os)).toEqual([false, true, false, true]);
  });

  it('does not fire for the opposite direction', () => {
    expect(fires(run(above, [snap(3351), snap(3349)]))).toEqual([false, false]);
    const below = mk({ type: 'price_cross', direction: 'below', level: 3350, source: 'bid' });
    expect(fires(run(below, [snap(3351), snap(3349.9)]))).toEqual([false, true]);
  });

  it('detects a gap through the level (no tick at the level)', () => {
    expect(fires(run(above, [snap(3340), snap(3380)]))).toEqual([false, true]);
  });

  it('survives a market-closed gap: stale feed keeps position, first tick of the new week fires', () => {
    const friday = T0;
    const monday = T0 + 3 * 86400_000;
    const os = run(above, [
      snap(3345, { now: friday }),
      snap(3345, { now: friday + 3600_000, feedStatus: { state: 'stale' } }),
      snap(3345, { now: friday + 2 * 86400_000, feedStatus: { state: 'stale' } }),
      snap(3362, { now: monday }),
    ]);
    expect(fires(os)).toEqual([false, false, false, true]);
  });

  it('forgets its position across a feed outage and across a restart (no fire on the first sample back)', () => {
    const outage = run(above, [snap(3349), snap(0, { tick: null, feedStatus: { state: 'disconnected' } }), snap(3360)]);
    expect(fires(outage)).toEqual([false, false, false]);
    expect(outage[1]!.status).toBe('waiting');
    const first = run(above, [snap(3349)]);
    const restarted = forgetSamples(first[0]!.state);
    expect(fires(run(above, [snap(3360)], restarted))).toEqual([false]);
  });

  it('uses the chosen price source', () => {
    const ask = mk({ type: 'price_cross', direction: 'above', level: 3350, source: 'ask' });
    // bid 3349.9 / ask 3350.1
    expect(fires(run(ask, [snap(3349.5), snap(3349.9)]))).toEqual([false, true]);
    expect(run(ask, [snap(3349.5), snap(3349.9)])[1]!.values.source).toBe('ask');
  });

  it('treats an edited level as a new baseline instead of firing on the change', () => {
    const [first] = run(above, [snap(3349)]);
    const moved = { ...above, condition: { ...above.condition, level: 3340 } } as Alert; // same armedAt, level moved under it
    expect(fires(run(moved, [snap(3349)], first!.state))).toEqual([false]);
  });

  it('re-arming (new armedAt) starts from a clean state', () => {
    const [a, b] = run(above, [snap(3349), snap(3351)]);
    expect(b!.fire).toBe(true);
    const rearmed = { ...above, armedAt: T0 + 5 } as Alert;
    expect(evaluateAlert(rearmed, snap(3360), a!.state).state.fireCount).toBe(0);
  });

  it('is disabled / expired / done aware', () => {
    expect(evaluateAlert({ ...above, enabled: false }, snap(3349)).status).toBe('disabled');
    const exp = { ...above, expiresAt: T0 + 1000 } as Alert;
    const o = run(exp, [snap(3349), snap(3351, { now: T0 + 2000 })]);
    expect(o[1]).toMatchObject({ fire: false, status: 'expired' });
  });
});

describe('repeat policies', () => {
  const cross = (repeat: Repeat) => mk({ type: 'price_cross', direction: 'above', level: 100 * 33.5, source: 'bid' }, { repeat });
  const zig = (t: number, hi = 3351) => [snap(3349, { now: t }), snap(hi, { now: t + 1000 })];

  it('once: fires a single time then reports done, even after more crossings', () => {
    const a = cross({ mode: 'once' });
    const os = run(a, [snap(3349), snap(3351), snap(3349), snap(3351)]);
    expect(fires(os)).toEqual([false, true, false, false]);
    expect(os[3]!.status).toBe('done');
  });

  it('every time with a cooldown suppresses refires inside the window and reports why', () => {
    const a = cross({ mode: 'every', cooldownSec: 60 });
    const os = run(a, [
      snap(3349, { now: T0 }), snap(3351, { now: T0 + 1000 }), // fire
      snap(3349, { now: T0 + 2000 }), snap(3351, { now: T0 + 30_000 }), // inside cooldown
      snap(3349, { now: T0 + 40_000 }), snap(3351, { now: T0 + 62_000 }), // after cooldown
    ]);
    expect(fires(os)).toEqual([false, true, false, false, false, true]);
    expect(os[3]!.reason).toMatch(/cooldown/);
    expect(os[3]!.status).toBe('ok');
  });

  it('once per bar: a second crossing in the same M15 bar is suppressed, the next bar fires', () => {
    const a = cross({ mode: 'per_bar', timeframe: 'M15' as Timeframe });
    const bar = Math.floor(T0 / 900_000) * 900_000;
    const os = run(a, [
      ...zig(bar + 1000), // fire at bar+2s
      ...zig(bar + 60_000), // same bar
      ...zig(bar + 900_000 + 1000), // next bar
    ]);
    expect(fires(os)).toEqual([false, true, false, false, false, true]);
    expect(os[3]!.reason).toMatch(/already fired in this M15 bar/);
  });
});

describe('persistence of "already fired"', () => {
  it('a restart (state saved as JSON, price memory forgotten) does not fire a once-alert again', () => {
    const a = mk({ type: 'price_cross', direction: 'above', level: 3350, source: 'bid' });
    const os = run(a, [snap(3349), snap(3351)]);
    expect(os[1]!.fire).toBe(true);
    const saved = JSON.parse(JSON.stringify(os[1]!.state)) as AlertState;
    const after = run(a, [snap(3349), snap(3355), snap(3349), snap(3355)], forgetSamples(saved));
    expect(fires(after)).toEqual([false, false, false, false]);
    expect(after[1]!.status).toBe('done');
    expect(saved.fireCount).toBe(1);
  });
  it('an every-time alert keeps its cooldown across a restart', () => {
    const a = mk({ type: 'price_cross', direction: 'above', level: 3350, source: 'bid' }, { repeat: { mode: 'every', cooldownSec: 600 } });
    const os = run(a, [snap(3349, { now: T0 }), snap(3351, { now: T0 + 1000 })]);
    const saved = JSON.parse(JSON.stringify(os[1]!.state)) as AlertState;
    const after = run(a, [snap(3349, { now: T0 + 5000 }), snap(3351, { now: T0 + 6000 })], forgetSamples(saved));
    expect(fires(after)).toEqual([false, false]);
    expect(after[1]!.reason).toMatch(/cooldown/);
  });
});

describe('zone events', () => {
  const range = (event: 'touch' | 'enter' | 'exit') => mk({ type: 'zone', event, target: { kind: 'range', low: 3340, high: 3345 }, source: 'bid' }, { repeat: { mode: 'every', cooldownSec: 0 } });
  it('enter fires when price goes from outside to inside, once', () => {
    expect(fires(run(range('enter'), [snap(3350), snap(3346), snap(3344), snap(3343), snap(3338), snap(3341)]))).toEqual([false, false, true, false, false, true]);
  });
  it('exit fires when price leaves the zone', () => {
    expect(fires(run(range('exit'), [snap(3342), snap(3343), snap(3346), snap(3344), snap(3338)]))).toEqual([false, false, true, false, true]);
  });
  it('touch fires on entering and also when price jumps clean through the zone', () => {
    expect(fires(run(range('touch'), [snap(3350), snap(3344.5)]))).toEqual([false, true]);
    expect(fires(run(range('touch'), [snap(3350), snap(3330)]))).toEqual([false, true]);
    expect(run(range('touch'), [snap(3350), snap(3330)])[1]!.reason).toMatch(/gap through/);
    expect(fires(run(range('enter'), [snap(3350), snap(3330)]))).toEqual([false, false]);
  });
  it('is inclusive of the zone edges', () => {
    expect(fires(run(range('touch'), [snap(3347), snap(3345)]))).toEqual([false, true]);
  });
  it('reads the bounds of a zone drawing and reports a deleted one as invalid', () => {
    const z = makeDrawing({ kind: 'zone', a: { time: 1, price: 3345 }, b: { time: 2, price: 3340 } }, { id: 'z1' });
    const a = mk({ type: 'zone', event: 'enter', target: { kind: 'drawing', drawingId: 'z1' }, source: 'bid' });
    expect(fires(run(a, [snap(3350, { drawings: [z] }), snap(3342, { drawings: [z] })]))).toEqual([false, true]);
    expect(evaluateAlert(a, snap(3342, { drawings: [] })).status).toBe('invalid');
    expect(referenceIssue(a.condition, [])).toMatch(/not found/);
    expect(referenceIssue(a.condition, [z])).toBeNull();
  });
});

describe('trendline touch', () => {
  // rising line: 3300 at t=1000 -> 3310 at t=2000 (0.01 per second)
  const line = makeDrawing({ kind: 'trendline', a: { time: 1000, price: 3300 }, b: { time: 2000, price: 3310 }, extend: 'right' }, { id: 'tl' }) as Drawing;
  const a = mk({ type: 'trendline', drawingId: 'tl', tolerance: 0, source: 'bid' }, { repeat: { mode: 'every', cooldownSec: 0 } });
  it('evaluates the line at the tick time, not at a fixed level', () => {
    expect(linePriceAt(line, 1500)).toBeCloseTo(3305);
    expect(linePriceAt(line, 3000)).toBeCloseTo(3320);
    // price flat at 3306: below the line at t=1700 (3307), above it at t=1500 (3305)
    const s = (t: number, p: number) => snap(p, { drawings: [line], tickTime: t });
    expect(fires(run(a, [s(1500, 3306), s(1600, 3306), s(1700, 3306)]))).toEqual([false, true, false]);
  });
  it('respects extend=none and reports waiting outside the line', () => {
    const seg = { ...line, extend: 'none' } as Drawing;
    expect(linePriceAt(seg, 3000)).toBeNull();
    expect(evaluateAlert(a, snap(3320, { drawings: [seg], tickTime: 3000 })).status).toBe('waiting');
    const ray = makeDrawing({ kind: 'ray', a: { time: 1000, price: 3300 }, b: { time: 2000, price: 3310 } }) as Drawing;
    expect(linePriceAt(ray, 500)).toBeNull();
  });
  it('uses tolerance as a band and does not double fire while hugging the line', () => {
    const tol = mk({ type: 'trendline', drawingId: 'tl', tolerance: 0.5, source: 'bid' }, { repeat: { mode: 'every', cooldownSec: 0 } });
    const s = (t: number, p: number) => snap(p, { drawings: [line], tickTime: t });
    // line at t=1500 is 3305
    expect(fires(run(tol, [s(1500, 3310), s(1500, 3305.4), s(1500, 3305.2), s(1500, 3305.0), s(1500, 3302), s(1500, 3305.3)]))).toEqual([false, true, false, false, false, true]);
  });
  it('works on a horizontal line too', () => {
    const h = makeDrawing({ kind: 'hline', price: 3350 }, { id: 'h' }) as Drawing;
    const hl = mk({ type: 'trendline', drawingId: 'h', tolerance: 0, source: 'bid' });
    expect(fires(run(hl, [snap(3340, { drawings: [h] }), snap(3351, { drawings: [h] })]))).toEqual([false, true]);
    expect(evaluateAlert(hl, snap(3340, { drawings: [makeDrawing({ kind: 'text', at: { time: 1, price: 1 }, text: 'x' }, { id: 'h' })] })).status).toBe('invalid');
  });
});

describe('candle close', () => {
  const candle = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });
  const m15 = 900;
  const base = Math.floor(T0 / 1000 / m15) * m15;
  const mkS = (candles: Candle[], tickTime: number) => snap(3340, { tickTime, lastClosedCandlesByTf: { M15: candles } });
  const a = mk({ type: 'candle_close', timeframe: 'M15', direction: 'above', level: 3350 }, { repeat: { mode: 'every', cooldownSec: 0 } });

  it('does not fire on the first sample or on candles seen before', () => {
    const c = [candle(base - 2 * m15, 3360), candle(base - m15, 3361)];
    expect(fires(run(a, [mkS(c, base + 10), mkS(c, base + 20)]))).toEqual([false, false]);
  });
  it('fires when a newly closed candle closes above, and only once per candle', () => {
    const c0 = [candle(base - m15, 3345)];
    const c1 = [...c0, candle(base, 3352)];
    const os = run(a, [mkS(c0, base + 10), mkS(c1, base + m15 + 5), mkS(c1, base + m15 + 6)]);
    expect(fires(os)).toEqual([false, true, false]);
    expect(os[1]!.values).toMatchObject({ close: 3352, level: 3350, timeframe: 'M15' });
  });
  it('ignores the still-forming candle even if the host passes it', () => {
    const forming = candle(base, 3399);
    const os = run(a, [mkS([candle(base - m15, 3340)], base + 10), mkS([candle(base - m15, 3340), forming], base + 400)]);
    expect(fires(os)).toEqual([false, false]);
  });
  it('catches a match among several candles closed while the feed was away (gap)', () => {
    const c0 = [candle(base - m15, 3340)];
    const c1 = [...c0, candle(base, 3341), candle(base + m15, 3355), candle(base + 2 * m15, 3342)];
    expect(fires(run(a, [mkS(c0, base + 10), mkS(c1, base + 3 * m15 + 5)]))).toEqual([false, true]);
  });
  it('supports closes below', () => {
    const b = mk({ type: 'candle_close', timeframe: 'M15', direction: 'below', level: 3350 });
    const c0 = [candle(base - m15, 3360)];
    expect(fires(run(b, [mkS(c0, base + 10), mkS([...c0, candle(base, 3349)], base + m15 + 1)]))).toEqual([false, true]);
  });
  it('waits when there is no candle data', () => {
    expect(evaluateAlert(a, snap(3340)).status).toBe('waiting');
  });
});

describe('spread and feed', () => {
  it('spread fires on the transition above the threshold, not while it stays above', () => {
    const a = mk({ type: 'spread', threshold: 0.6 }, { repeat: { mode: 'every', cooldownSec: 0 } });
    const os = run(a, [snap(3350, { spread: 0.3 }), snap(3350, { spread: 0.9 }), snap(3350, { spread: 1.2 }), snap(3350, { spread: 0.4 }), snap(3350, { spread: 0.7 })]);
    expect(fires(os)).toEqual([false, true, false, false, true]);
    expect(os[1]!.values).toMatchObject({ spread: 0.9, threshold: 0.6 });
  });
  it('spread already high at start does not fire', () => {
    expect(fires(run(mk({ type: 'spread', threshold: 0.6 }), [snap(3350, { spread: 2 }), snap(3350, { spread: 2 })]))).toEqual([false, false]);
  });
  it('feed stale / disconnected / either', () => {
    const feed = (state: 'stale' | 'disconnected' | 'either') => mk({ type: 'feed', state }, { repeat: { mode: 'every', cooldownSec: 0 } });
    const st = (state: FeedStatus['state']) => snap(0, { tick: null, feedStatus: { state, message: 'x' } });
    expect(fires(run(feed('stale'), [st('connected'), st('stale'), st('stale'), st('connected'), st('stale')]))).toEqual([false, true, false, false, true]);
    expect(fires(run(feed('disconnected'), [st('connected'), st('stale'), st('disconnected'), st('error')]))).toEqual([false, false, true, false]);
    expect(fires(run(feed('either'), [st('connected'), st('stale'), st('disconnected')]))).toEqual([false, true, false]);
  });
  it('does not fire for a feed that is disconnected when the app starts', () => {
    const st = (state: FeedStatus['state']) => snap(0, { tick: null, feedStatus: { state } });
    expect(fires(run(mk({ type: 'feed', state: 'disconnected' }), [st('disconnected'), st('disconnected')]))).toEqual([false, false]);
    expect(fires(run(mk({ type: 'feed', state: 'disconnected' }), [st('starting'), st('disconnected')]))).toEqual([false, true]);
  });
});

describe('position plan', () => {
  const buy = makeDrawing({ kind: 'position', side: 'buy', entryTime: 1, entry: 3350, stopLoss: 3340, takeProfits: [{ price: 3360, closePct: 50 }, { price: 3370, closePct: 50 }] }, { id: 'p1' }) as Drawing;
  const sell = makeDrawing({ kind: 'position', side: 'sell', entryTime: 1, entry: 3350, stopLoss: 3360, takeProfits: [{ price: 3340, closePct: 100 }] }, { id: 'p2' }) as Drawing;
  const ev = (id: string, event: 'entry' | 'sl' | 'tp', tpIndex?: number) => mk({ type: 'position_plan', drawingId: id, event, tpIndex }, { repeat: { mode: 'every', cooldownSec: 0 } });
  const s = (p: number, d: Drawing) => snap(p, { drawings: [d] });

  it('buy: entry on ask, SL and TPs on bid', () => {
    // ask = bid + 0.2
    expect(fires(run(ev('p1', 'entry'), [s(3345, buy), s(3349.9, buy)]))).toEqual([false, true]);
    expect(fires(run(ev('p1', 'sl'), [s(3345, buy), s(3340.1, buy), s(3339.9, buy), s(3335, buy)]))).toEqual([false, false, true, false]);
    expect(fires(run(ev('p1', 'tp', 1), [s(3355, buy), s(3359.9, buy), s(3360, buy)]))).toEqual([false, false, true]);
    expect(fires(run(ev('p1', 'tp', 2), [s(3355, buy), s(3365, buy)]))).toEqual([false, false]);
  });
  it('sell: SL is above entry, TP below, exits judged on ask', () => {
    // ask = bid + 0.2
    expect(fires(run(ev('p2', 'sl'), [s(3350, sell), s(3359.7, sell)]))).toEqual([false, false]);
    expect(fires(run(ev('p2', 'sl'), [s(3350, sell), s(3359.8, sell)]))).toEqual([false, true]);
    expect(fires(run(ev('p2', 'tp', 1), [s(3345, sell), s(3339.7, sell)]))).toEqual([false, true]);
  });
  it('reports a missing TP or non-position drawing as invalid', () => {
    expect(evaluateAlert(ev('p2', 'tp', 3), s(3345, sell)).status).toBe('invalid');
    const line = makeDrawing({ kind: 'hline', price: 1 }, { id: 'p1' });
    expect(evaluateAlert(ev('p1', 'sl'), s(3345, line)).status).toBe('invalid');
    expect(referenceIssue({ type: 'position_plan', drawingId: 'p2', event: 'tp', tpIndex: 3 }, [sell])).toMatch(/no TP3/);
  });
});

describe('sessions and schedules', () => {
  const at = (iso: string) => Date.parse(iso);
  const sessionAlert = (session: 'london' | 'newyork' | 'tokyo' | 'sydney', event: 'open' | 'close', armed: string) =>
    mk({ type: 'session', session, event }, { now: at(armed), repeat: { mode: 'every', cooldownSec: 0 } });
  const at0 = (now: number) => snap(3350, { now });

  it('London opens at 08:00 local: 07:00Z in summer (BST), 08:00Z in winter (GMT)', () => {
    const summer = sessionAlert('london', 'open', '2026-07-14T06:00:00Z');
    const win = sessionAlert('london', 'open', '2026-12-14T06:00:00Z');
    expect(fires(run(summer, [at0(at('2026-07-14T06:59:30Z')), at0(at('2026-07-14T07:00:10Z'))]))).toEqual([false, true]);
    expect(fires(run(win, [at0(at('2026-12-14T07:00:10Z')), at0(at('2026-12-14T08:00:10Z'))]))).toEqual([false, true]);
  });

  it('New York open moves by an hour across the US DST change (2026-03-08) while UTC hours stay editable', () => {
    const fri = eventOccurrences({ type: 'session', session: 'newyork', event: 'open' }, at('2026-03-06T20:00:00Z'));
    const mon = eventOccurrences({ type: 'session', session: 'newyork', event: 'open' }, at('2026-03-09T20:00:00Z'));
    expect(new Date(fri.latest!).toISOString()).toBe('2026-03-06T13:00:00.000Z'); // EST
    expect(new Date(mon.latest!).toISOString()).toBe('2026-03-09T12:00:00.000Z'); // EDT
    // editable fixed UTC hours override the zone
    const fixed = eventOccurrences({ type: 'session', session: 'newyork', event: 'open', hours: { tz: 'UTC', open: '13:00', close: '22:00' } }, at('2026-03-09T20:00:00Z'));
    expect(new Date(fixed.latest!).toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('the UK and US DST changes are three weeks apart: London/NY gap is 4h, then 5h, then 4h', () => {
    const gap = (day: string) => {
      const n = at(`${day}T23:00:00Z`);
      const l = eventOccurrences({ type: 'session', session: 'london', event: 'open' }, n).latest!;
      const y = eventOccurrences({ type: 'session', session: 'newyork', event: 'open' }, n).latest!;
      return (y - l) / 3_600_000;
    };
    expect(gap('2026-03-04')).toBe(5); // both on winter time
    expect(gap('2026-03-11')).toBe(4); // US already on DST, UK not yet
    expect(gap('2026-03-31')).toBe(5); // both on summer time
  });

  it('does not fire on weekends and skips to Monday', () => {
    const a = sessionAlert('london', 'open', '2026-10-23T00:00:00Z'); // Friday
    const os = run(a, [at0(at('2026-10-24T07:30:00Z')), at0(at('2026-10-25T08:30:00Z')), at0(at('2026-10-26T07:30:00Z')), at0(at('2026-10-26T08:00:30Z'))]);
    expect(fires(os)).toEqual([false, false, false, true]);
    expect(new Date(eventOccurrences({ type: 'session', session: 'london', event: 'open' }, at('2026-10-24T12:00:00Z')).next!).toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('Sydney close and Tokyo open work in their own zones', () => {
    const syd = sessionAlert('sydney', 'close', '2026-12-14T00:00:00Z'); // AEDT +11 -> 16:00 = 05:00Z
    expect(fires(run(syd, [at0(at('2026-12-14T04:59:00Z')), at0(at('2026-12-14T05:00:20Z'))]))).toEqual([false, true]);
    const tok = sessionAlert('tokyo', 'open', '2026-10-21T00:00:00Z'); // 09:00 JST = 00:00Z next day (armed earlier)
    expect(fires(run(tok, [at0(at('2026-10-21T23:59:00Z')), at0(at('2026-10-22T00:00:30Z'))]))).toEqual([false, true]);
  });

  it('a session spanning midnight closes on the next day', () => {
    const c = { type: 'session', session: 'london', event: 'close', hours: { tz: 'UTC', open: '22:00', close: '06:00' } } as const;
    expect(new Date(eventOccurrences(c, at('2026-10-21T12:00:00Z')).latest!).toISOString()).toBe('2026-10-21T06:00:00.000Z');
    expect(new Date(eventOccurrences(c, at('2026-10-21T12:00:00Z')).next!).toISOString()).toBe('2026-10-22T06:00:00.000Z');
  });

  it('daily schedule fires once per day at the local time, across DST (London 09:00)', () => {
    const cond = { type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'Europe/London', weekdaysOnly: false } } as const;
    const a = mk(cond, { now: at('2026-03-27T00:00:00Z'), repeat: { mode: 'every', cooldownSec: 0 } });
    const os = run(a, [
      at0(at('2026-03-27T08:59:00Z')), at0(at('2026-03-27T09:00:05Z')), at0(at('2026-03-27T09:30:00Z')),
      at0(at('2026-03-28T09:00:05Z')), // Saturday, still GMT
      at0(at('2026-03-29T08:00:05Z')), // Sunday: BST began at 01:00Z -> 09:00 BST = 08:00Z
      at0(at('2026-03-29T08:30:00Z')),
    ]);
    expect(fires(os)).toEqual([false, true, false, true, true, false]);
  });

  it('weekdays-only skips Saturday and Sunday', () => {
    const a = mk({ type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'UTC', weekdaysOnly: true } }, { now: at('2026-10-23T00:00:00Z'), repeat: { mode: 'every', cooldownSec: 0 } });
    const os = run(a, [at0(at('2026-10-23T09:00:01Z')), at0(at('2026-10-24T09:00:01Z')), at0(at('2026-10-25T09:00:01Z')), at0(at('2026-10-26T09:00:01Z'))]);
    expect(fires(os)).toEqual([true, false, false, true]);
  });

  it('one-off schedule fires once at its time and is then done', () => {
    const a = mk({ type: 'schedule', when: { kind: 'once', at: '2026-10-21T10:30:00+00:00' } }, { now: T0 });
    const os = run(a, [at0(T0 + 600_000), at0(T0 + 1800_000 + 5000), at0(T0 + 1800_000 + 8000), at0(T0 + 86400_000)]);
    expect(fires(os)).toEqual([false, true, false, false]);
    expect(os[3]!.status).toBe('done');
  });

  it('one-off with an offset is converted to the right instant', () => {
    const c = { type: 'schedule', when: { kind: 'once', at: '2026-10-21T13:00:00+03:00' } } as const;
    expect(new Date(eventOccurrences(c, T0 - 1).next!).toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });

  it('a time event older than the grace window is reported as missed and never fires late', () => {
    const a = mk({ type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'UTC', weekdaysOnly: false } }, { now: at('2026-10-20T00:00:00Z'), repeat: { mode: 'every', cooldownSec: 0 } });
    const os = run(a, [at0(at('2026-10-21T12:00:00Z')), at0(at('2026-10-21T12:00:01Z'))]);
    expect(fires(os)).toEqual([false, false]);
    expect(os[0]).toMatchObject({ status: 'missed' });
    expect(os[0]!.reason).toMatch(/Missed/);
    expect(os[1]!.status).toBe('ok');
    expect(LATE_GRACE_MS).toBeGreaterThan(0);
  });

  it('persisted lastOccurrence prevents a double fire after restart inside the grace window', () => {
    const a = mk({ type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'UTC', weekdaysOnly: false } }, { now: at('2026-10-20T00:00:00Z'), repeat: { mode: 'every', cooldownSec: 0 } });
    const [o] = run(a, [at0(at('2026-10-21T09:00:10Z'))]);
    expect(o!.fire).toBe(true);
    const saved = JSON.parse(JSON.stringify(o!.state)) as AlertState;
    expect(fires(run(a, [at0(at('2026-10-21T09:01:00Z'))], forgetSamples(saved)))).toEqual([false]);
  });

  it('an alert armed after the event time does not fire for it (no fire on first sample)', () => {
    const a = mk({ type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'UTC', weekdaysOnly: false } }, { now: at('2026-10-21T09:00:30Z') });
    expect(fires(run(a, [at0(at('2026-10-21T09:00:40Z')), at0(at('2026-10-22T09:00:05Z'))]))).toEqual([false, true]);
  });
});

describe('helpers', () => {
  it('describes conditions and renders templates', () => {
    expect(describeCondition({ type: 'candle_close', timeframe: 'H1', direction: 'above', level: 3350 })).toBe('H1 candle closes above 3350.00');
    expect(renderMessage('{name}: {price} vs {level} {unknown}', { name: 'A', price: '3350.10', level: null })).toBe('A: 3350.10 vs {level} {unknown}');
  });
  it('builds alert drafts for drawings', () => {
    const h = makeDrawing({ kind: 'hline', price: 3340 }) as Drawing;
    expect(alertDraftsForDrawing(h, 3350)[0]!.condition).toMatchObject({ type: 'price_cross', direction: 'below', level: 3340 });
    expect(alertDraftsForDrawing(h, 3330)[0]!.condition).toMatchObject({ direction: 'above' });
    const p = makeDrawing({ kind: 'position', side: 'buy', entryTime: 1, entry: 3350, stopLoss: 3340, takeProfits: [{ price: 3360, closePct: 100 }] }) as Drawing;
    expect(alertDraftsForDrawing(p, 3350).map((d) => d.label)).toEqual(['Entry reached', 'Stop loss reached', 'TP1 reached']);
    expect(alertDraftsForDrawing(makeDrawing({ kind: 'text', at: { time: 1, price: 1 }, text: 'x' }), null)).toEqual([]);
  });
});

describe('near (approaching) alert', () => {
  const zone = makeDrawing({ kind: 'zone', a: { time: 1000, price: 2650 }, b: { time: 2000, price: 2655 } }, { id: 'z1', label: 'H1 demand', note: 'Reaction zone' });
  const a = mk({ type: 'near', drawingId: 'z1', distance: 3, source: 'bid' });
  it('fires once when price enters the widened band from outside, not on the first sample', () => {
    const o = run(a, [snap(2670, { drawings: [zone] }), snap(2662, { drawings: [zone] }), snap(2657.5, { drawings: [zone] }), snap(2652, { drawings: [zone] })]);
    expect(fires(o)).toEqual([false, false, true, false]);
    expect(o[2]!.reason).toMatch(/entered the band 2647\.00-2658\.00/);
  });
  it('is invalid when the drawing is gone and is offered as a draft', () => {
    expect(run(a, [snap(2670)])[0]!.status).toBe('invalid');
    expect(alertDraftsForDrawing(zone, 2670).some((d) => d.condition.type === 'near')).toBe(true);
    expect(referenceIssue(a.condition, [zone])).toBeNull();
  });
});
