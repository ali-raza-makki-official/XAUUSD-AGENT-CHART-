import { describe, expect, it } from 'vitest';
import { AppConfigSchema, type AnyOrderCommand, type BrokerSnapshot, type OrderRecord, type PrepareResult, type TradePlan } from '@aurum/core';
import { AssistantService, type PlanStore } from './assistant';

const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 0.01 };

function rig(over: { assistant?: object; trading?: boolean; gateFail?: string; positions?: BrokerSnapshot['positions'] } = {}) {
  const cfg = AppConfigSchema.parse({ symbol: 'XAUUSD', brokerSymbol: 'GOLD', pipSize: 0.1, trading: { enabled: over.trading ?? true }, assistant: { enabled: true, autoManage: true, ...over.assistant } });
  const store = new Map<string, TradePlan>();
  const plans: PlanStore = { list: () => [...store.values()].sort((a, b) => b.createdAt - a.createdAt), save: (p) => { store.set(p.id, p); } };
  const sent: AnyOrderCommand[] = [];
  const notes: string[] = []; const asks: string[] = [];
  let tick = { bid: 2650, ask: 2650.2, time: 1 };
  let positions = over.positions ?? [];
  let n = 0; let clock = 1_000_000;
  const kv = new Map<string, string>();
  const svc = new AssistantService({
    getConfig: () => cfg,
    engine: {
      prepare: async (raw): Promise<PrepareResult> => {
        const c = raw as AnyOrderCommand; sent.push(c);
        const gate = { ok: !over.gateFail, failed: over.gateFail ? { rule: 'max_spread', message: over.gateFail } : null, failures: [], warnings: [], numbers: {} } as never;
        return { ok: true, commandId: c.commandId, command: c, preview: { title: 't', lines: [], text: '', destructive: false } as never, gate, executable: !over.gateFail, account: null, expiresAt: 0, existing: null };
      },
      confirm: async (id) => ({ commandId: id, state: 'confirmed', ticket: 4242, broker: { positionTicket: 4242 }, reason: null } as unknown as OrderRecord),
    },
    snapshot: async () => ({ account: { demo: true, balance: 10000, currency: 'USD' }, tick, spec, positions, orders: [] }),
    plans, kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => { kv.set(k, v); } },
    notify: (t) => { notes.push(t); }, ask: (_p, t) => { asks.push(t); }, changed: () => undefined,
    now: () => clock, newId: () => `plan-${String(++n).padStart(8, '0')}`,
  });
  const base = { side: 'buy' as const, zone: { low: 2640, high: 2645 }, createdBy: 'manual' as const };
  return { svc, sent, notes, asks, plans, store, setTick: (b: number, a: number) => { tick = { bid: b, ask: a, time: tick.time + 1 }; }, setPositions: (p: BrokerSnapshot['positions']) => { positions = p; }, advance: (ms: number) => { clock += ms; }, base, kv };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('assistant plans', () => {
  it('needs the master switch and trading, and only arms what the user approves', async () => {
    const off = rig({ assistant: { enabled: false } });
    const p = off.svc.create(off.base);
    await expect(off.svc.approve(p.id)).rejects.toThrow(/Trade Assistant/);
    const noTrade = rig({ trading: false });
    await expect(noTrade.svc.approve(noTrade.svc.create(noTrade.base).id)).rejects.toThrow(/Trading is off/);
    const ok = rig();
    const armed = await ok.svc.approve(ok.svc.create(ok.base).id);
    expect(armed.status).toBe('armed');
    expect(ok.svc.approvedIds()).toEqual([armed.id]);
  });

  it('asks once when the zone is reached; "take" places the order sized in pips', async () => {
    const r = rig();
    const plan = await r.svc.approve(r.svc.create({ ...r.base, slPips: 70, tpPips: 140, riskPct: 0.3 }).id);
    await r.svc.onTick({ bid: 2650, ask: 2650.2 });
    expect(r.asks).toHaveLength(0);
    r.setTick(2644.8, 2645); await r.svc.onTick({ bid: 2644.8, ask: 2645 }); await r.svc.onTick({ bid: 2644.6, ask: 2644.8 });
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]).toMatch(/Zone reached.*SL 70 pips, TP 140 pips/);
    expect(r.svc.get(plan.id)!.status).toBe('asking');
    expect(r.sent).toHaveLength(0); // nothing is sent until the user says yes
    const taken = await r.svc.take(plan.id);
    expect(taken.status).toBe('filled');
    expect(r.sent[0]).toMatchObject({ type: 'open_market', actor: 'rule', side: 'buy', volume: 0.04, sl: 2638, tp: 2659, planId: plan.id });
    expect(r.notes.at(-1)).toMatch(/Trade taken: BUY 0\.04 lot at 2645\.00, SL 2638\.00 \(70 pips\), TP 2659\.00 \(140 pips\)/);
  });

  it('auto-take places the order by itself, once, when the user approved it that way', async () => {
    const r = rig();
    await r.svc.approve(r.svc.create(r.base).id, { autoTake: true });
    r.setTick(2644.8, 2645);
    await r.svc.onTick({ bid: 2644.8, ask: 2645 }); await r.svc.onTick({ bid: 2644.7, ask: 2644.9 }); await flush();
    expect(r.sent).toHaveLength(1);
    expect(r.svc.list()[0]!.status).toBe('filled');
  });

  it('the risk gate can refuse; the plan is blocked with the reason and nothing is placed', async () => {
    const r = rig({ gateFail: 'Spread 1.20 is above your maximum 0.60.' });
    const plan = await r.svc.approve(r.svc.create(r.base).id, { autoTake: true });
    r.setTick(2644.8, 2645); await r.svc.onTick({ bid: 2644.8, ask: 2645 }); await flush();
    expect(r.svc.get(plan.id)).toMatchObject({ status: 'blocked', statusDetail: expect.stringContaining('Spread 1.20') });
    expect(r.notes.at(-1)).toMatch(/Plan not placed: Spread 1\.20/);
  });

  it('stops a plan when price slices through the zone, and when it expires', async () => {
    const r = rig();
    const a = await r.svc.approve(r.svc.create(r.base).id);
    await r.svc.onTick({ bid: 2630, ask: 2630.2 });
    expect(r.svc.get(a.id)!.status).toBe('blocked');
    const b = await r.svc.approve(r.svc.create({ ...r.base, expiresAt: 1_000_500 }).id);
    r.advance(1000); await r.svc.onTick({ bid: 2650, ask: 2650.2 });
    expect(r.svc.get(b.id)!.status).toBe('expired');
  });

  it('a limit plan places its pending order right at approval, at the zone edge', async () => {
    const r = rig();
    const plan = await r.svc.approve(r.svc.create({ ...r.base, entry: 'limit' }).id);
    expect(plan.status).toBe('filled');
    expect(r.sent[0]).toMatchObject({ type: 'open_pending', orderType: 'buy_limit', price: 2645, sl: 2638, planId: plan.id });
  });
});

describe('assistant management in pips', () => {
  const pos = (over: object = {}) => ({ ticket: 77, time: 1, symbol: 'GOLD', type: 'buy', volume: 0.1, priceOpen: 2650, priceCurrent: 2655.5, sl: 2643, tp: null, swap: 0, profit: 55, magic: 0, comment: '', ...over }) as never;

  it('moves the stop to breakeven + cushion at +50 pips, announces it in pips, and does not repeat', async () => {
    const r = rig({ positions: [pos()] });
    r.setTick(2655.2, 2655.4);
    await r.svc.onTick({ bid: 2655.2, ask: 2655.4 }); await flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ type: 'modify_sltp', actor: 'rule', ticket: 77, sl: 2650.2 });
    expect(r.notes.at(-1)).toMatch(/#77 Stop to breakeven \+2 pips \(2650\.20\) at \+52\.0 pips\. Now \+52\.0 pips\./);
    r.setPositions([pos({ sl: 2650.2 })]); r.advance(2000);
    await r.svc.onTick({ bid: 2655.2, ask: 2655.4 }); await flush();
    expect(r.sent).toHaveLength(1);
  });

  it('does nothing when the assistant or auto-manage is off', async () => {
    const off = rig({ positions: [pos()], assistant: { autoManage: false } });
    await off.svc.onTick({ bid: 2655.2, ask: 2655.4 }); await flush();
    expect(off.sent).toHaveLength(0);
  });

  it('a refused action is retried only after a pause, not every second', async () => {
    const r = rig({ positions: [pos()], gateFail: 'daily limit' });
    r.setTick(2655.2, 2655.4);
    await r.svc.onTick({ bid: 2655.2, ask: 2655.4 }); await flush();
    r.advance(2000); await r.svc.onTick({ bid: 2655.2, ask: 2655.4 }); await flush();
    expect(r.sent).toHaveLength(1);
    r.advance(40_000); await r.svc.onTick({ bid: 2655.2, ask: 2655.4 }); await flush();
    expect(r.sent).toHaveLength(2);
  });
});
