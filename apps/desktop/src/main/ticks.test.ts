import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from './schema';
import { TickStore } from './ticks';
import { PaperService, SqlitePaperStore } from './paper';
import { AppConfigSchema, type TradePlan } from '@aurum/core';

const mem = () => { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); return db; };

describe('TickStore', () => {
  it('stores only quotes that changed, returns ranges in order, and purges old rows', () => {
    const db = mem(); const s = new TickStore(() => db);
    expect(s.record(1000, 2650, 2650.2)).toBe(true);
    expect(s.record(1100, 2650, 2650.2)).toBe(false); // same quote: no new information
    s.record(1200, 2650.1, 2650.3); s.record(5000, 2651, 2651.2);
    expect(s.range(1000, 2000).map((r) => r.ts)).toEqual([1000, 1200]);
    expect(s.stats()).toMatchObject({ count: 3, first: 1000, last: 5000 });
    expect(s.purge(2000)).toBe(2);
    expect(s.stats().count).toBe(1);
    expect(s.record(10, -1, 0)).toBe(false); // nonsense quotes are refused
  });
});

describe('PaperService', () => {
  const cfg = AppConfigSchema.parse({ pipSize: 0.1 });
  const plan = (o: Partial<TradePlan> = {}): TradePlan => ({ id: 'plan-aaaaaaaa', createdAt: 1, createdBy: 'ai', side: 'buy', zone: { low: 2640, high: 2645 }, entry: 'touch', slPips: 70, tpPips: 140, riskPct: 0.3, autoTake: false, expiresAt: 9e12, status: 'proposed', statusDetail: '', note: 'x', ...o });

  it('every plan gets a paper shadow, judged on ticks whether or not it was traded live', () => {
    const db = mem(); let clock = 1_000_000;
    const svc = new PaperService({ getConfig: () => cfg, store: new SqlitePaperStore(() => db), changed: () => undefined, now: () => clock });
    svc.syncPlan(plan()); svc.syncPlan(plan()); // idempotent
    expect(svc.list()).toHaveLength(1);
    svc.onTick({ ts: clock, bid: 2644.7, ask: 2644.9 }); // zone reached: the paper trade opens
    expect(svc.list()[0]).toMatchObject({ status: 'open', source: 'plan', live: false });
    svc.onTick({ ts: clock + 1, bid: 2659, ask: 2659.2 });
    const t = svc.list()[0]!;
    expect(t).toMatchObject({ status: 'won', resultPips: 140 });
    expect(new SqlitePaperStore(() => db).list()[0]!.status).toBe('won'); // persisted
    expect(t.tags).toMatchObject({ createdBy: 'ai', zonePips: 50 });
  });

  it('marks the paper trade "also placed live" when the real order exists, and survives a restart', () => {
    const db = mem(); const store = new SqlitePaperStore(() => db);
    const a = new PaperService({ getConfig: () => cfg, store, changed: () => undefined });
    a.syncPlan(plan()); a.syncPlan(plan({ status: 'filled', ticket: 7 }));
    expect(a.list()[0]!.live).toBe(true);
    const b = new PaperService({ getConfig: () => cfg, store, changed: () => undefined }); // after a restart
    b.onTick({ ts: Date.now(), bid: 2644.7, ask: 2644.9 });
    expect(b.list()[0]!.status).toBe('open');
  });
});
