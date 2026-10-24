import { describe, expect, it } from 'vitest';
import {
  AiPermissionsSchema, BrokerNotSent, DEFAULT_RISK_SETTINGS, OrderEngine, RiskSettingsSchema, slMoveAllowedAfterLimit, stampCommand,
  type BrokerPort, type BrokerPosition, type BrokerSnapshot, type EngineSettings, type Evidence,
} from '../src';

const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 0.01 };
const pos = (o: Partial<BrokerPosition> = {}): BrokerPosition => ({ ticket: 11, time: 0, type: 'buy', volume: 0.1, priceOpen: 2650, sl: 2645, tp: null, priceCurrent: 2651, swap: 0, profit: 5, symbol: 'GOLD', magic: 0, comment: '', ...o });
const emptyEv = (): Evidence => ({ tag: 't', queried: { positions: true, orders: true, deals: true, historyOrders: true }, positions: [], orders: [], deals: [], historyOrders: [], target: null });

function setup(over: { settings?: Partial<EngineSettings>; positions?: BrokerPosition[]; dailyPnl?: number; script?: ('ok' | 'throw' | 'notsent' | 'unknown')[] } = {}) {
  let now = 1_700_000_000_000;
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const finds: string[] = [];
  const script = [...(over.script ?? [])];
  let evidence = emptyEv();
  const snap = (): BrokerSnapshot => ({ account: { demo: true, balance: 10000, currency: 'USD' }, tick: { bid: 2650.1, ask: 2650.3, time: 1_700_000_000 }, spec, positions: over.positions ?? [], orders: [] });
  const broker: BrokerPort = {
    snapshot: async () => snap(),
    deals: async () => (over.dailyPnl ? [{ ticket: 1, order: 1, time: 1_699_999_999, type: 'sell', entry: 'out', positionId: 1, volume: 1, price: 1, commission: 0, swap: 0, profit: over.dailyPnl, fee: 0, reason: 'client', symbol: 'GOLD', magic: 0, comment: '' }] : []),
    execute: async (action, body) => {
      calls.push({ action, body });
      const s = script.shift() ?? 'ok';
      if (s === 'throw') throw new Error('timeout');
      if (s === 'notsent') throw new BrokerNotSent('refused', 'x');
      if (s === 'unknown') return { status: 'unknown', message: 'no result' };
      return { status: 'done', retcode: 10009, retcodeName: 'DONE', message: 'ok', positionTicket: 77, order: 77 };
    },
    find: async (id) => { finds.push(id); return evidence; },
  };
  const settings: EngineSettings = { tradingEnabled: true, risk: DEFAULT_RISK_SETTINGS, aiPermissions: AiPermissionsSchema.parse({}), allowedSymbols: ['GOLD'], pipSize: 0.1, ...over.settings };
  const engine = new OrderEngine({ broker, settings: () => settings, now: () => now, noTraceGapMs: 1000 });
  const mk = (body: { type: string; [k: string]: unknown }, actor: 'manual' | 'ai' = 'manual', id?: string) => stampCommand(body, { actor, symbol: 'GOLD', now, commandId: id ?? `cmd-${Math.random().toString(16).slice(2, 12)}` });
  return { engine, calls, finds, mk, advance: (ms: number) => { now += ms; }, setEvidence: (e: Evidence) => { evidence = e; } };
}
const buy = { type: 'open_market', side: 'buy', volume: 0.04, sl: 2640.3, tp: 2670, deviationPoints: 20 };

describe('order engine safety properties', () => {
  it('a duplicate commandId never executes twice (sequential and concurrent)', async () => {
    for (let n = 1; n <= 20; n++) {
      const t = setup();
      const cmd = t.mk(buy);
      expect((await t.engine.prepare(cmd)).ok).toBe(true);
      const rs = await Promise.all(Array.from({ length: n }, () => t.engine.confirm(cmd.commandId)));
      await t.engine.confirm(cmd.commandId);
      expect(t.calls.length).toBe(1);
      expect(rs.every((r) => r.state === 'confirmed')).toBe(true);
      expect((await t.engine.prepare(cmd)).ok && 'existing' in (await t.engine.prepare(cmd))).toBe(true);
    }
  });

  it('an unknown result is never resent: retry reconciles via find first', async () => {
    const t = setup({ script: ['throw'] });
    const cmd = t.mk(buy);
    await t.engine.prepare(cmd);
    const r = await t.engine.confirm(cmd.commandId);
    expect(r.state).toBe('unknown_reconcile');
    expect((await t.engine.confirm(cmd.commandId)).state).toBe('unknown_reconcile');
    expect(t.calls.length).toBe(1);
    // no trace yet: still unknown after the first check
    expect((await t.engine.reconcile(cmd.commandId)).state).toBe('unknown_reconcile');
    expect(t.finds.length).toBe(1);
    // evidence appears: confirmed from MT5, never resent
    t.setEvidence({ ...emptyEv(), positions: [pos({ ticket: 99, magic: 1096041045 })] });
    expect((await t.engine.reconcile(cmd.commandId)).state).toBe('confirmed');
    expect(t.calls.length).toBe(1);
  });

  it('no trace must be seen twice, apart, before rejected; new opens are blocked meanwhile', async () => {
    const t = setup({ script: ['throw'] });
    const a = t.mk(buy);
    await t.engine.prepare(a); await t.engine.confirm(a.commandId);
    const b = t.mk(buy);
    await t.engine.prepare(b);
    expect((await t.engine.confirm(b.commandId)).failedRule).toBe('unresolved_command');
    await t.engine.reconcile(a.commandId);
    expect(t.engine.registry.get(a.commandId)!.state).toBe('unknown_reconcile');
    t.advance(2000);
    expect((await t.engine.reconcile(a.commandId)).state).toBe('rejected');
  });

  it('bridge refusal means not sent -> rejected; gate failure sends nothing', async () => {
    const t = setup({ script: ['notsent'] });
    const a = t.mk(buy); await t.engine.prepare(a);
    expect((await t.engine.confirm(a.commandId)).state).toBe('rejected');
    const t2 = setup({ settings: { tradingEnabled: false } });
    const b = t2.mk(buy); await t2.engine.prepare(b);
    const r = await t2.engine.confirm(b.commandId);
    expect(r.state).toBe('validation_failed'); expect(r.failedRule).toBe('trading_disabled'); expect(t2.calls.length).toBe(0);
  });

  it('AI cannot execute in suggest mode; confirm mode needs the specific permission; kill switch blocks AI but not manual', async () => {
    const t = setup();
    const a = t.mk(buy, 'ai'); await t.engine.prepare(a);
    expect((await t.engine.confirm(a.commandId)).failedRule).toBe('ai_suggest_only');
    const confirmMode = AiPermissionsSchema.parse({ orders: 'confirm' });
    const t2 = setup({ settings: { aiPermissions: confirmMode }, positions: [pos()] });
    const m = t2.mk({ type: 'modify_sltp', ticket: 11, sl: 2648 }, 'ai'); await t2.engine.prepare(m);
    expect((await t2.engine.confirm(m.commandId)).failedRule).toBe('ai_permission_missing');
    const o = t2.mk(buy, 'ai'); await t2.engine.prepare(o);
    expect((await t2.engine.confirm(o.commandId)).state).toBe('confirmed');
    t2.engine.setKillSwitch(true);
    const o2 = t2.mk(buy, 'ai'); await t2.engine.prepare(o2);
    expect((await t2.engine.confirm(o2.commandId)).failedRule).toBe('kill_switch');
    const man = t2.mk({ type: 'close_position', ticket: 11 }, 'manual'); await t2.engine.prepare(man);
    expect((await t2.engine.confirm(man.commandId)).state).toBe('confirmed');
    const auto = setup({ settings: { aiPermissions: AiPermissionsSchema.parse({ orders: 'automatic' }) } });
    const x = auto.mk(buy, 'ai'); await auto.engine.prepare(x);
    expect((await auto.engine.confirm(x.commandId)).failedRule).toBe('ai_automatic_disabled');
  });

  it('bulk close needs its own permission for the AI', async () => {
    const base = { orders: 'confirm', sltpAndPartialClose: true } as const;
    const t = setup({ settings: { aiPermissions: AiPermissionsSchema.parse(base) }, positions: [pos()] });
    const c = t.mk({ type: 'close_all' }, 'ai'); await t.engine.prepare(c);
    expect((await t.engine.confirm(c.commandId)).failedRule).toBe('bulk_close_permission');
    const t2 = setup({ settings: { aiPermissions: AiPermissionsSchema.parse({ ...base, bulkClose: true }) }, positions: [pos(), pos({ ticket: 12 })] });
    const c2 = t2.mk({ type: 'close_all' }, 'ai'); await t2.engine.prepare(c2);
    const r = await t2.engine.confirm(c2.commandId);
    expect(r.state).toBe('confirmed'); expect(t2.calls.length).toBe(2);
  });

  it('daily limit blocks new risk and SL widening but allows moving toward safety and closing', async () => {
    const risk = RiskSettingsSchema.parse({ maxDailyLossPct: 2 });
    const lim = { dailyPnl: -300, positions: [pos()], settings: { risk } };
    const t = setup(lim);
    const o = t.mk(buy); await t.engine.prepare(o);
    expect((await t.engine.confirm(o.commandId)).failedRule).toBe('daily_limit_hit');
    const widen = t.mk({ type: 'modify_sltp', ticket: 11, sl: 2640 }); await t.engine.prepare(widen);
    expect((await t.engine.confirm(widen.commandId)).failedRule).toBe('sl_widen_after_limit');
    const safe = t.mk({ type: 'modify_sltp', ticket: 11, sl: 2649 }); await t.engine.prepare(safe);
    expect((await t.engine.confirm(safe.commandId)).state).toBe('confirmed');
    const cl = t.mk({ type: 'close_position', ticket: 11 }); await t.engine.prepare(cl);
    expect((await t.engine.confirm(cl.commandId)).state).toBe('confirmed');
  });

  it('property: after the limit, the gate allows an SL move iff it does not add risk', async () => {
    const risk = RiskSettingsSchema.parse({ maxDailyLossPct: 2, maxRiskPerTradePct: 100 });
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 60; i++) {
      const oldSl = 2640 + rnd() * 9, newSl = 2640 + rnd() * 9.5;
      const t = setup({ dailyPnl: -300, positions: [pos({ sl: oldSl })], settings: { risk } });
      const m = t.mk({ type: 'modify_sltp', ticket: 11, sl: Number(newSl.toFixed(2)) }); await t.engine.prepare(m);
      const r = await t.engine.confirm(m.commandId);
      const expected = slMoveAllowedAfterLimit(spec, 'buy', 2650, 0.1, oldSl, Number(newSl.toFixed(2)));
      expect(r.state === 'confirmed').toBe(expected);
    }
  });

  it('partial close respects the volume step and never exceeds the position', async () => {
    const t = setup({ positions: [pos({ volume: 0.1 })] });
    for (const [vol, ok] of [[0.05, true], [0.1, false], [0.2, false], [0.055, false], [0.095, false]] as const) {
      const c = t.mk({ type: 'partial_close', ticket: 11, volume: vol }); await t.engine.prepare(c);
      expect((await t.engine.confirm(c.commandId)).state === 'confirmed').toBe(ok);
    }
  });

  it('expired commands and a reused id with another payload are refused; restore turns sent_to_broker into unknown', async () => {
    const t = setup();
    const a = t.mk(buy, 'manual', 'fixed-id-0001'); await t.engine.prepare(a);
    expect((await t.engine.prepare({ ...a, volume: 0.2 })).ok).toBe(false);
    t.advance(130_000);
    expect((await t.engine.confirm(a.commandId)).failedRule).toBe('command_expired');
    const t2 = setup();
    const rec = { ...(t.engine.registry.get('fixed-id-0001')!), state: 'sent_to_broker' as const };
    t2.engine.restore([rec]);
    expect(t2.engine.registry.get('fixed-id-0001')!.state).toBe('unknown_reconcile');
  });
});
