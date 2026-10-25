import { describe, expect, it } from 'vitest';
import {
  AlertMonitor, AlertStore, DesktopChannel, DrawingStore, NotificationLog, NotificationPolicy, NotificationRegistry, NotificationRouter, NotificationSettingsSchema,
  AiPermissionsSchema, inQuietHours, makeAlert, makeDrawing, referenceIssue, runAiTool, toolCatalog,
  type AlertCommand, type AlertSnapshot, type AlertState, type AlertsPort, type ChartState, type FireRecord, type NotificationChannel, type NotificationEvent, type ToolContext,
} from '../src';

const T0 = Date.parse('2026-10-21T10:00:00Z');
let n = 0;
const id = () => `id-${++n}-xxxxxxxxxxxx`;

const crossCond = (level: number, direction: 'above' | 'below' = 'above') => ({ type: 'price_cross' as const, direction, level, source: 'bid' as const });
const snap = (bid: number, now = T0, spread = 0.2): AlertSnapshot => ({
  tick: { symbol: 'GOLD', bid, ask: bid + spread, time: Math.floor(now / 1000), spread }, lastClosedCandlesByTf: {}, drawings: [], now, feedStatus: { state: 'connected' },
});
const create = (store: AlertStore, cond: ReturnType<typeof crossCond>, o: Parameters<typeof makeAlert>[1] = {}, actor: 'manual' | 'ai' = 'manual') => {
  const alert = makeAlert(cond, { id: id(), now: store['now']?.() ?? T0, actor, ...o });
  return { alert, result: store.dispatch({ commandId: id(), actor, label: 'create', ops: [{ op: 'create', alert }] }) };
};

function rig(settings = NotificationSettingsSchema.parse({})) {
  let clock = T0;
  const store = new AlertStore({ now: () => clock });
  const log = new NotificationLog();
  const registry = new NotificationRegistry();
  const router = new NotificationRouter(registry, log, () => clock);
  const shown: { event: NotificationEvent; silent: boolean }[] = [];
  registry.register(new DesktopChannel((event, o) => shown.push({ event, silent: o.silent }), () => settings, () => clock));
  const saved: { states: Record<string, AlertState>; fires: FireRecord[] } = { states: {}, fires: [] };
  const monitor = new AlertMonitor({
    store, router, now: () => clock, newId: id,
    persistence: { saveState: (a, s) => { saved.states[a] = JSON.parse(JSON.stringify(s)); }, saveFire: (f) => saved.fires.push(f) },
  });
  return { store, log, registry, router, monitor, shown, saved, setClock: (t: number) => { clock = t; }, get clock() { return clock; } };
}

describe('AlertStore', () => {
  it('is idempotent per commandId and supports undo/redo', () => {
    const store = new AlertStore({ now: () => T0 });
    const alert = makeAlert(crossCond(3350), { id: 'a-1', now: T0 });
    const cmd: AlertCommand = { commandId: 'cmd-00001', actor: 'manual', label: 'create', ops: [{ op: 'create', alert }] };
    expect(store.dispatch(cmd)).toMatchObject({ ok: true, duplicate: false });
    expect(store.dispatch(cmd)).toMatchObject({ ok: true, duplicate: true });
    expect(store.list()).toHaveLength(1);
    store.undo();
    expect(store.list()).toHaveLength(0);
    store.redo();
    expect(store.list()).toHaveLength(1);
  });

  it('rejects invalid commands atomically and mismatched origin', () => {
    const store = new AlertStore({ now: () => T0 });
    const good = makeAlert(crossCond(3350), { id: 'a-1', now: T0 });
    const r = store.dispatch({ commandId: 'cmd-00002', actor: 'manual', label: 'x', ops: [{ op: 'create', alert: good }, { op: 'delete', id: 'missing' }] });
    expect(r).toMatchObject({ ok: false });
    expect(store.list()).toHaveLength(0);
    const ai = makeAlert(crossCond(3350), { id: 'a-2', now: T0, actor: 'ai' });
    expect(store.dispatch({ commandId: 'cmd-00003', actor: 'manual', label: 'x', ops: [{ op: 'create', alert: ai }] })).toMatchObject({ ok: false });
    expect(store.dispatch({ commandId: 'x', actor: 'manual', label: 'x', ops: [] } as never)).toMatchObject({ ok: false });
  });

  it('rejects schedules and expiries that are already in the past', () => {
    const store = new AlertStore({ now: () => T0 });
    const past = makeAlert({ type: 'schedule', when: { kind: 'once', at: '2026-10-21T09:00:00Z' } }, { id: 'a-1', now: T0 });
    expect(store.dispatch({ commandId: 'cmd-00004', actor: 'manual', label: 'x', ops: [{ op: 'create', alert: past }] })).toMatchObject({ ok: false, error: expect.stringMatching(/past/) });
    const old = makeAlert(crossCond(3350), { id: 'a-2', now: T0, expiresAt: T0 - 1 });
    expect(store.dispatch({ commandId: 'cmd-00005', actor: 'manual', label: 'x', ops: [{ op: 'create', alert: old }] })).toMatchObject({ ok: false });
  });

  it('update re-arms on condition change, enabling and explicit rearm, but not on a rename', () => {
    let clock = T0;
    const store = new AlertStore({ now: () => clock });
    const { alert } = create(store, crossCond(3350));
    clock += 1000;
    store.dispatch({ commandId: 'cmd-10001', actor: 'manual', label: 'rename', ops: [{ op: 'update', id: alert.id, patch: { name: 'Gold 3350' } }] });
    expect(store.get(alert.id)!.armedAt).toBe(T0);
    clock += 1000;
    store.dispatch({ commandId: 'cmd-10002', actor: 'manual', label: 'move', ops: [{ op: 'update', id: alert.id, patch: { condition: crossCond(3360) } }] });
    expect(store.get(alert.id)!.armedAt).toBe(T0 + 2000);
    clock += 1000;
    store.dispatch({ commandId: 'cmd-10003', actor: 'manual', label: 'off', ops: [{ op: 'update', id: alert.id, patch: { enabled: false } }] });
    expect(store.get(alert.id)!.armedAt).toBe(T0 + 2000);
    clock += 1000;
    store.dispatch({ commandId: 'cmd-10004', actor: 'manual', label: 'on', ops: [{ op: 'update', id: alert.id, patch: { enabled: true } }] });
    expect(store.get(alert.id)!.armedAt).toBe(T0 + 4000);
    clock += 1000;
    store.dispatch({ commandId: 'cmd-10005', actor: 'manual', label: 'rearm', ops: [{ op: 'update', id: alert.id, patch: { rearm: true } }] });
    expect(store.get(alert.id)!.armedAt).toBe(T0 + 5000);
    expect(store.dispatch({ commandId: 'cmd-10006', actor: 'manual', label: 'bad', ops: [{ op: 'update', id: alert.id, patch: { origin: {} } as never }] })).toMatchObject({ ok: false });
  });

  it('limits the AI to 50 alerts and validates references through the hook', () => {
    const store = new AlertStore({ now: () => T0, checkReferences: (c) => referenceIssue(c, []) });
    expect(create(store, { type: 'trendline', drawingId: 'nope', tolerance: 0, source: 'bid' } as never).result).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    const s2 = new AlertStore({ now: () => T0 });
    for (let i = 0; i < 50; i++) expect(create(s2, crossCond(3300 + i), {}, 'ai').result.ok).toBe(true);
    expect(create(s2, crossCond(3400), {}, 'ai').result).toMatchObject({ ok: false, error: expect.stringMatching(/at most 50/) });
    expect(create(s2, crossCond(3400)).result.ok).toBe(true);
  });
});

describe('AlertMonitor + notifications', () => {
  it('fires exactly once, logs the reason and values, and delivers one desktop notification', async () => {
    const r = rig();
    const { alert } = create(r.store, crossCond(3350), { name: 'Gold 3350', channels: { desktop: true, sound: true } });
    expect(r.monitor.evaluate(snap(3349))).toEqual([]);
    const f1 = r.monitor.evaluate(snap(3351, T0 + 1000));
    const f2 = r.monitor.evaluate(snap(3352, T0 + 2000));
    const f3 = r.monitor.evaluate(snap(3349, T0 + 3000));
    const f4 = r.monitor.evaluate(snap(3355, T0 + 4000));
    await r.monitor.flush();
    expect(f1).toHaveLength(1);
    expect([f2, f3, f4].map((f) => f.length)).toEqual([0, 0, 0]);
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]!.silent).toBe(false);
    const entry = r.log.recent()[0]!;
    expect(entry.event).toMatchObject({ alertId: alert.id, title: 'Gold 3350', severity: 'info' });
    expect(entry.event.body).toMatch(/crossed above 3350/);
    expect(entry.deliveries).toEqual([expect.objectContaining({ channel: 'desktop', status: 'sent' })]);
    expect(r.monitor.view()[0]).toMatchObject({ status: 'done', fireCount: 1 });
    expect(r.saved.fires).toHaveLength(1);
  });

  it('persisted state survives a restart: a new monitor with the saved state does not fire a once-alert again', () => {
    const a = rig();
    const { alert } = create(a.store, crossCond(3350));
    a.monitor.evaluate(snap(3349));
    a.monitor.evaluate(snap(3351, T0 + 1000));
    const b = rig();
    b.store.load([alert]);
    b.monitor.loadStates(a.saved.states);
    expect(b.monitor.evaluate(snap(3349, T0 + 5000))).toEqual([]);
    expect(b.monitor.evaluate(snap(3351, T0 + 6000))).toEqual([]);
    expect(b.monitor.view()[0]).toMatchObject({ status: 'done', fireCount: 1 });
  });

  it('a missed schedule is recorded in the history but sends no notification', async () => {
    const r = rig();
    create(r.store, { type: 'schedule', when: { kind: 'daily', time: '09:00', tz: 'UTC', weekdaysOnly: false } } as never, { repeat: { mode: 'every', cooldownSec: 0 } });
    r.setClock(T0 + 86400_000);
    const out = r.monitor.evaluate(snap(3350, T0 + 86400_000));
    await r.monitor.flush();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'missed', notificationId: null });
    expect(r.shown).toHaveLength(0);
  });

  it('one bad alert (deleted drawing) does not stop the others', () => {
    const r = rig();
    const dead = makeAlert({ type: 'trendline', drawingId: 'gone', tolerance: 0, source: 'bid' }, { id: 'dead', now: T0 });
    r.store.load([dead]);
    create(r.store, crossCond(3350));
    r.monitor.evaluate(snap(3349));
    const out = r.monitor.evaluate(snap(3351, T0 + 1000));
    expect(out).toHaveLength(1);
    expect(r.monitor.view().find((v) => v.alert.id === 'dead')).toMatchObject({ status: 'invalid' });
  });

  it('renders the message template', async () => {
    const r = rig();
    create(r.store, crossCond(3350), { message: '{name} hit {price} (level {level})', name: 'Break' });
    r.monitor.evaluate(snap(3349));
    r.monitor.evaluate(snap(3350.55, T0 + 1000));
    await r.monitor.flush();
    expect(r.log.recent()[0]!.event.body).toBe('Break hit 3350.55 (level 3350.00)');
  });
});

describe('notification channels and policy', () => {
  const ev = (o: Partial<NotificationEvent> = {}): NotificationEvent => ({ id: id(), alertId: 'a', title: 't', body: 'b', severity: 'info', at: T0, data: { channels: { desktop: true, whatsapp: true } }, ...o });

  it('another worker can register a channel without touching alert code; routing follows the alert flags', async () => {
    const r = rig();
    const got: NotificationEvent[] = [];
    const wa: NotificationChannel = { id: 'whatsapp', label: 'WhatsApp', send: (e) => { got.push(e); return { status: 'sent' }; } };
    const off = r.registry.register(wa);
    create(r.store, crossCond(3350), { channels: { whatsapp: true } });
    create(r.store, crossCond(3360), { channels: { whatsapp: false } });
    r.monitor.evaluate(snap(3340));
    r.monitor.evaluate(snap(3365, T0 + 1000));
    await r.monitor.flush();
    expect(got).toHaveLength(1);
    expect(got[0]!.data.channels).toMatchObject({ whatsapp: true });
    expect(r.shown).toHaveLength(2);
    off();
    expect(r.registry.get('whatsapp')).toBeUndefined();
  });

  it('a throwing channel is logged as failed and does not block the others', async () => {
    const registry = new NotificationRegistry();
    const log = new NotificationLog();
    const ok: NotificationChannel = { id: 'desktop', label: 'd', send: () => ({ status: 'sent' }) };
    registry.register({ id: 'whatsapp', label: 'w', send: () => { throw new Error('boom'); } });
    registry.register(ok);
    const entry = await new NotificationRouter(registry, log).dispatch(ev());
    expect(entry.deliveries.map((d) => [d.channel, d.status]).sort()).toEqual([['desktop', 'sent'], ['whatsapp', 'failed']]);
    expect(entry.deliveries.find((d) => d.status === 'failed')!.detail).toBe('boom');
  });

  it('per-severity switches, desktop master switch and sound flag', () => {
    const shown: boolean[] = [];
    const s = NotificationSettingsSchema.parse({ severities: { info: false } });
    const ch = new DesktopChannel((_e, o) => shown.push(o.silent), () => s);
    expect(ch.send(ev({ severity: 'info' }))).toMatchObject({ status: 'suppressed', detail: expect.stringMatching(/info/) });
    expect(ch.send(ev({ severity: 'warning', data: { channels: { desktop: true, sound: true } } }))).toEqual({ status: 'sent' });
    expect(shown).toEqual([false]);
    const quiet = new DesktopChannel((_e, o) => shown.push(o.silent), () => NotificationSettingsSchema.parse({ sound: false }));
    quiet.send(ev({ data: { channels: { desktop: true, sound: true } } }));
    expect(shown.at(-1)).toBe(true);
    const off = new DesktopChannel(() => shown.push(true), () => NotificationSettingsSchema.parse({ desktopEnabled: false }));
    expect(off.send(ev())).toMatchObject({ status: 'suppressed' });
  });

  it('quiet hours cross midnight, use their own time zone and let critical through when allowed', () => {
    const q = NotificationSettingsSchema.parse({ quietHours: { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Karachi', allowCritical: true } }).quietHours;
    // Karachi is UTC+5: 17:30Z = 22:30 local
    expect(inQuietHours(q, Date.parse('2026-10-21T17:30:00Z'))).toBe(true);
    expect(inQuietHours(q, Date.parse('2026-10-21T01:59:00Z'))).toBe(true); // 06:59 local
    expect(inQuietHours(q, Date.parse('2026-10-21T02:00:00Z'))).toBe(false); // 07:00 local
    expect(inQuietHours(q, Date.parse('2026-10-21T12:00:00Z'))).toBe(false);
    expect(inQuietHours({ ...q, enabled: false }, Date.parse('2026-10-21T17:30:00Z'))).toBe(false);
    let now = Date.parse('2026-10-21T17:30:00Z');
    const p = new NotificationPolicy(() => NotificationSettingsSchema.parse({ quietHours: q }), () => now);
    expect(p.check(ev({ severity: 'info' }))).toMatchObject({ allow: false, reason: expect.stringMatching(/quiet hours/) });
    expect(p.check(ev({ severity: 'critical' }))).toEqual({ allow: true });
    now = Date.parse('2026-10-21T12:00:00Z');
    expect(p.check(ev({ severity: 'info', alertId: 'z' }))).toEqual({ allow: true });
  });

  it('throttles floods (critical exempt) and recovers after the window', () => {
    let now = T0;
    const p = new NotificationPolicy(() => NotificationSettingsSchema.parse({ throttle: { max: 3, windowSec: 60 }, dedupeSec: 0 }), () => now);
    const results = Array.from({ length: 5 }, (_, i) => p.check(ev({ alertId: `a${i}` })).allow);
    expect(results).toEqual([true, true, true, false, false]);
    expect(p.check(ev({ alertId: 'c', severity: 'critical' })).allow).toBe(true);
    now += 61_000;
    expect(p.check(ev({ alertId: 'later' })).allow).toBe(true);
  });

  it('drops an identical notification inside the dedupe window only', () => {
    let now = T0;
    const p = new NotificationPolicy(() => NotificationSettingsSchema.parse({ dedupeSec: 30 }), () => now);
    expect(p.check(ev()).allow).toBe(true);
    now += 10_000;
    expect(p.check(ev())).toMatchObject({ allow: false, reason: expect.stringMatching(/duplicate/) });
    expect(p.check(ev({ body: 'different' })).allow).toBe(true);
    now += 31_000;
    expect(p.check(ev()).allow).toBe(true);
  });

  it('the in-app log keeps suppressed notifications with the reason', async () => {
    const r = rig(NotificationSettingsSchema.parse({ severities: { info: false } }));
    create(r.store, crossCond(3350));
    r.monitor.evaluate(snap(3349));
    r.monitor.evaluate(snap(3351, T0 + 1000));
    await r.monitor.flush();
    expect(r.shown).toHaveLength(0);
    expect(r.log.recent()[0]!.deliveries[0]).toMatchObject({ channel: 'desktop', status: 'suppressed' });
  });
});

describe('AI alert tools', () => {
  const state: ChartState = { symbol: 'XAUUSD', brokerSymbol: 'GOLD', timeframe: 'M15', feed: 'connected', bid: 3350, ask: 3350.2, spread: 0.2, tickTime: 1, account: null, selectedDrawingId: null, pipSize: 0.1 };
  function ctx(perms = {}) {
    const r = rig();
    const port: AlertsPort = { snapshot: () => r.monitor.snapshot(), dispatch: (c) => r.store.dispatch(c) };
    const c: ToolContext = {
      store: new DrawingStore(), permissions: AiPermissionsSchema.parse({ alertsAndSetups: true, ...perms }), getState: () => state, getCandles: async () => [], getSpec: () => null,
      startOfToday: () => 0, newId: id, now: () => T0, alerts: port,
    };
    return { r, c };
  }

  it('is hidden and denied without the alertsAndSetups permission', async () => {
    const { c } = ctx({ alertsAndSetups: false });
    const names = toolCatalog(c.permissions).map((t) => t.name);
    for (const t of ['create_alert', 'list_alerts', 'update_alert', 'delete_alert', 'get_notifications']) expect(names).not.toContain(t);
    expect(await runAiTool(c, 'create_alert', { condition: crossCond(3360), reason: 'test alert' })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(toolCatalog(AiPermissionsSchema.parse({ alertsAndSetups: true })).map((t) => t.name)).toContain('create_alert');
  });

  it('creates an AI-origin alert through the shared store, with a reason, and lists it', async () => {
    const { r, c } = ctx();
    const res = await runAiTool(c, 'create_alert', { name: 'NY break', condition: { type: 'price_cross', direction: 'above', level: 3360 }, reason: 'Resistance from H1', channels: { whatsapp: true } });
    expect(res.ok).toBe(true);
    const a = r.store.list()[0]!;
    expect(a).toMatchObject({ name: 'NY break', channels: { desktop: true, whatsapp: true }, repeat: { mode: 'once' } });
    expect(a.origin).toMatchObject({ by: 'ai', reason: 'Resistance from H1' });
    const list = await runAiTool(c, 'list_alerts', {});
    expect(list).toMatchObject({ ok: true, data: [expect.objectContaining({ id: a.id, origin: 'ai', status: 'pending' })] });
    r.store.undo();
    expect(r.store.list()).toHaveLength(0);
  });

  it('rejects absurd prices, bad input and missing drawings', async () => {
    const { c } = ctx();
    expect(await runAiTool(c, 'create_alert', { condition: crossCond(33.5), reason: 'typo here' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await runAiTool(c, 'create_alert', { condition: { type: 'price_cross', direction: 'sideways', level: 3350 }, reason: 'bad dir' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await runAiTool(c, 'create_alert', { condition: { type: 'trendline', drawingId: 'nope' }, reason: 'missing line' })).toMatchObject({ ok: false, code: 'invalid_input', error: expect.stringMatching(/not found/) });
    expect(await runAiTool(c, 'create_alert', { condition: { type: 'schedule', when: { kind: 'once', at: '2026-10-21T09:00:00Z' } }, reason: 'in the past' })).toMatchObject({ ok: false, code: 'rejected', error: expect.stringMatching(/past/) });
  });

  it('references real drawings, updates and deletes by id', async () => {
    const { r, c } = ctx();
    c.store.dispatch({ commandId: 'seed-0001', actor: 'manual', label: 's', ops: [{ op: 'create', drawing: makeDrawing({ kind: 'zone', a: { time: 1, price: 3345 }, b: { time: 2, price: 3340 } }, { id: 'zone-1' }) }] });
    const created = await runAiTool(c, 'create_alert', { condition: { type: 'zone', event: 'enter', target: { kind: 'drawing', drawingId: 'zone-1' } }, reason: 'demand zone' });
    expect(created.ok).toBe(true);
    const aid = r.store.list()[0]!.id;
    expect(await runAiTool(c, 'update_alert', { updates: [{ id: aid, patch: { enabled: false, expiresAt: '2026-10-22T00:00:00Z' }, reason: 'pause it' }] })).toMatchObject({ ok: true });
    expect(r.store.get(aid)).toMatchObject({ enabled: false, expiresAt: Date.parse('2026-10-22T00:00:00Z') });
    expect(await runAiTool(c, 'update_alert', { updates: [{ id: aid, patch: { origin: { by: 'manual' } }, reason: 'sneaky' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await runAiTool(c, 'update_alert', { updates: [{ id: 'missing', patch: { enabled: true }, reason: 'no such' }] })).toMatchObject({ ok: false, code: 'rejected' });
    expect(await runAiTool(c, 'delete_alert', { ids: [aid], reason: 'not needed' })).toMatchObject({ ok: true });
    expect(r.store.list()).toHaveLength(0);
  });

  it('get_notifications returns recent fires with the exact values and delivery results', async () => {
    const { r, c } = ctx();
    await runAiTool(c, 'create_alert', { condition: { type: 'price_cross', direction: 'above', level: 3360 }, reason: 'watch resistance' });
    r.monitor.evaluate(snap(3355));
    r.monitor.evaluate(snap(3361, T0 + 1000));
    await r.monitor.flush();
    const out = await runAiTool(c, 'get_notifications', { limit: 5 });
    expect(out).toMatchObject({ ok: true, data: [expect.objectContaining({ kind: 'fired', values: expect.objectContaining({ price: 3361, level: 3360 }), deliveries: [expect.objectContaining({ channel: 'desktop', status: 'sent' })] })] });
  });

  it('reports unavailable when the app did not give the AI an alert port', async () => {
    const { c } = ctx();
    expect(await runAiTool({ ...c, alerts: undefined }, 'list_alerts', {})).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('watching a drawing', () => {
  it('watch_drawing creates approaching + reached alerts; the notification carries label, note and validity', async () => {
    const r = rig();
    const drawings = new DrawingStore();
    const zone = makeDrawing({ kind: 'zone', a: { time: 1000, price: 2650 }, b: { time: 2000, price: 2655 } }, { id: 'z-watch', label: 'H1 demand', note: 'Wait for rejection' });
    drawings.dispatch({ commandId: id(), actor: 'manual', label: 'zone', ops: [{ op: 'create', drawing: zone }] });
    const port: AlertsPort = { snapshot: () => r.monitor.snapshot(), dispatch: (c: AlertCommand) => r.store.dispatch(c) };
    const ctx = {
      store: drawings, permissions: AiPermissionsSchema.parse({ drawingsEdit: true, chartRead: true, alertsAndSetups: true }), alerts: port, newId: id, now: () => T0,
      getState: () => ({ symbol: 'XAUUSD', timeframe: 'H1', bid: 2680, ask: 2680.2, spread: 0.2, feedStatus: 'connected', account: null, selectedDrawingId: null }),
    } as unknown as ToolContext;
    const res = await runAiTool(ctx, 'watch_drawing', { drawingId: 'z-watch', approachPips: 30, whatsapp: true, reason: 'user asked' });
    expect(res.ok).toBe(true);
    expect(r.store.list().map((a) => a.name)).toEqual(['Approaching: H1 demand', 'Reached: H1 demand']);
    expect(r.store.list().every((a) => a.channels.whatsapp)).toBe(true);
    const withZone = (bid: number): AlertSnapshot => ({ ...snap(bid), drawings: [zone] });
    r.monitor.evaluate(withZone(2680));
    r.monitor.evaluate(withZone(2657));
    await r.monitor.flush();
    const body = r.shown.at(-1)!.event.body;
    expect(body).toMatch(/Level: H1 demand/);
    expect(body).toMatch(/Note: Wait for rejection/);
  });
});
