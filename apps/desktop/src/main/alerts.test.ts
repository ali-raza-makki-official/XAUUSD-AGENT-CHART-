import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, makeAlert, type Alert, type Candle, type FeedStatus, type FireRecord, type NotificationLogEntry, type Tick, type Timeframe } from '@aurum/core';
import { AlertService, type AlertDb, type AlertFeed } from './alerts';

class FakeFeed extends EventEmitter implements AlertFeed {
  status: FeedStatus = { state: 'connected' };
  lastTick: Tick | null = null;
  candleCalls: Timeframe[] = [];
  bars: Candle[] = [];
  candles(tf: Timeframe): Promise<Candle[]> { this.candleCalls.push(tf); return Promise.resolve(this.bars); }
  tick(bid: number, time: number) { this.lastTick = { symbol: 'GOLD', bid, ask: bid + 0.2, time, spread: 0.2 }; this.emit('tick', this.lastTick); }
}

function memDb() {
  const m = { alerts: [] as Alert[], states: {} as Record<string, unknown>, fires: [] as FireRecord[], notifications: [] as NotificationLogEntry[], commandIds: [] as string[] };
  const db: AlertDb = {
    loadAlertData: () => ({ ...m, alerts: [...m.alerts], fires: [...m.fires] }),
    persistAlertChange: (p) => {
      for (const c of p.changes) { m.alerts = m.alerts.filter((a) => a.id !== c.id); if (c.after) m.alerts.push(c.after); }
      if (p.log.kind === 'do') m.commandIds.push(p.log.commandId);
    },
    saveAlertState: (id, s) => { m.states[id] = JSON.parse(JSON.stringify(s)); },
    saveAlertFire: (f) => { m.fires.push(f); },
    saveNotification: (e) => { m.notifications = [...m.notifications.filter((x) => x.event.id !== e.event.id), JSON.parse(JSON.stringify(e))]; },
    loadDrawings: () => ({ drawings: [] }),
  };
  return { m, db };
}

function build(mem = memDb(), feed = new FakeFeed()) {
  const shown: string[] = [];
  const svc = new AlertService({
    feed, db: mem.db, getConfig: () => ({ symbol: 'XAUUSD', notifications: DEFAULT_NOTIFICATION_SETTINGS }),
    show: (e) => { shown.push(e.title); },
  });
  svc.start();
  return { svc, feed, shown, mem };
}
const cross = (level: number) => makeAlert({ type: 'price_cross', direction: 'above', level, source: 'bid' }, { actor: 'manual' });
const create = (svc: AlertService, a: Alert) => svc.dispatch({ commandId: `cmd-${a.id}-12345`, actor: 'manual', label: 'c', ops: [{ op: 'create', alert: a }] });

describe('AlertService', () => {
  it('fires exactly once on a crossing, shows one desktop notification, persists, and does not refire after a restart', async () => {
    const t = build();
    const a = cross(2650);
    expect(create(t.svc, a).ok).toBe(true);
    t.feed.tick(2649, 1000); t.feed.tick(2649.5, 1001);
    expect(t.shown).toHaveLength(0);
    t.feed.tick(2651, 1002); t.feed.tick(2652, 1003); t.feed.tick(2640, 1004); t.feed.tick(2660, 1005);
    await t.svc.monitor.flush();
    expect(t.shown).toHaveLength(1);
    const snap = t.svc.snapshot();
    expect(snap.fires.filter((f) => f.kind === 'fired')).toHaveLength(1);
    expect(snap.notifications).toHaveLength(1);
    expect(snap.alerts[0]).toMatchObject({ status: 'done', fireCount: 1 });
    expect(t.mem.m.fires).toHaveLength(1);
    expect(t.mem.m.notifications[0]!.deliveries[0]).toMatchObject({ channel: 'desktop', status: 'sent' });

    // restart: new service over the same db
    const t2 = build(t.mem);
    expect(t2.svc.listView()).toHaveLength(1);
    t2.feed.tick(2670, 2000); t2.feed.tick(2680, 2001);
    await t2.svc.monitor.flush();
    expect(t2.shown).toHaveLength(0);
    expect(t2.svc.listView()[0]).toMatchObject({ status: 'done', fireCount: 1 });
    expect(t2.svc.snapshot().notifications).toHaveLength(1);
  });

  it('fetches closed candles only when a new bar appears', async () => {
    const t = build();
    create(t.svc, makeAlert({ type: 'candle_close', timeframe: 'M5', direction: 'above', level: 2650 }, { actor: 'manual' }));
    t.feed.tick(2640, 1000); t.feed.tick(2641, 1001); t.feed.tick(2642, 1002);
    await Promise.resolve(); await Promise.resolve();
    expect(t.feed.candleCalls).toEqual(['M5']);
  });

  it('reports a failed OS notification honestly and keeps the in-app log entry', async () => {
    const mem = memDb(); const feed = new FakeFeed();
    const svc = new AlertService({ feed, db: mem.db, getConfig: () => ({ symbol: 'XAUUSD', notifications: DEFAULT_NOTIFICATION_SETTINGS }), show: () => { throw new Error('no notification daemon'); } });
    svc.start();
    create(svc, cross(2650));
    feed.tick(2649, 1); feed.tick(2651, 2);
    await svc.monitor.flush();
    expect(svc.snapshot().notifications[0]!.deliveries[0]).toMatchObject({ status: 'failed', detail: 'no notification daemon' });
  });

  it('test fire notifies but is not a fire', async () => {
    const t = build();
    const a = cross(2650); create(t.svc, a);
    const fired: FireRecord[] = []; t.svc.on('fired', (f) => fired.push(f));
    expect((await t.svc.testFire(a.id)).ok).toBe(true);
    expect(t.shown).toEqual(['[Test] ' + a.name]);
    expect(t.svc.listView()[0]!.fireCount).toBe(0);
    expect(t.svc.snapshot().fires).toHaveLength(0);
    expect(fired).toHaveLength(1);
  });

  it('undo of a create removes the alert from the db', () => {
    const t = build();
    create(t.svc, cross(2650));
    expect(t.mem.m.alerts).toHaveLength(1);
    expect(t.svc.undo()).toBe(true);
    expect(t.mem.m.alerts).toHaveLength(0);
  });
});
