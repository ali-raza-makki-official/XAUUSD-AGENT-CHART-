import { describe, expect, it } from 'vitest';
import {
  ManageRulesSchema, TradePlanSchema, evaluateGate, manageDecisions, planOrder, profitPips, zoneBroken, zoneReached,
  type GateInput, type ManageRules, type OpenMarketCommand, type TradePlan,
} from '../src';

const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };
const plan = (o: Partial<TradePlan> = {}): TradePlan => TradePlanSchema.parse({
  id: 'plan-12345678', createdAt: 1, createdBy: 'manual', side: 'buy', zone: { low: 2640, high: 2645 }, entry: 'touch', slPips: 70, tpPips: 140, riskPct: 0.3,
  autoTake: false, expiresAt: 9e12, status: 'armed', ...o,
});
const rules = (o: Partial<ManageRules> = {}): ManageRules => ({ ...ManageRulesSchema.parse({}), ...o });

describe('pips maths', () => {
  it('measures profit in pips from the price a trade would close at', () => {
    expect(profitPips({ type: 'buy', priceOpen: 2650 }, { bid: 2655.3, ask: 2655.5 }, 0.1)).toBeCloseTo(53, 5);
    expect(profitPips({ type: 'sell', priceOpen: 2650 }, { bid: 2644.4, ask: 2644.6 }, 0.1)).toBeCloseTo(54, 5);
  });
});

describe('zones', () => {
  it('buys fire when the ask comes down into the zone, sells when the bid comes up into it', () => {
    expect(zoneReached(plan(), { bid: 2650, ask: 2650.2 })).toBe(false);
    expect(zoneReached(plan(), { bid: 2644.8, ask: 2645 })).toBe(true);
    expect(zoneReached(plan({ side: 'sell', zone: { low: 2660, high: 2665 } }), { bid: 2660.1, ask: 2660.3 })).toBe(true);
    expect(zoneBroken(plan(), { bid: 2638, ask: 2638.2 })).toBe(true);
  });
});

describe('plan to order', () => {
  it('sizes from risk % and the stop in pips; SL and TP are exactly pips away', () => {
    const r = planOrder(plan(), { tick: { bid: 2644.8, ask: 2645 }, spec, balance: 10000, pipSize: 0.1 });
    if ('error' in r) throw new Error(r.error);
    expect(r.lots).toBe(0.04); // 30 USD risk / (7.00 price = 700 USD per lot)
    expect(r.entry).toBe(2645);
    expect(r.sl).toBe(2638); // 70 pips = 7.00
    expect(r.tp).toBe(2659); // 140 pips = 14.00
    expect(r.body).toMatchObject({ type: 'open_market', side: 'buy', volume: 0.04, sl: 2638, tp: 2659, planId: 'plan-12345678' });
  });
  it('a limit plan becomes a pending order at the zone edge; sells mirror', () => {
    const r = planOrder(plan({ entry: 'limit', side: 'sell', zone: { low: 2660, high: 2665 } }), { tick: null, spec, balance: 10000, pipSize: 0.1 });
    if ('error' in r) throw new Error(r.error);
    expect(r.body).toMatchObject({ type: 'open_pending', orderType: 'sell_limit', price: 2660 });
    expect(r.sl).toBe(2667); expect(r.tp).toBe(2646);
  });
  it('refuses instead of guessing when data is missing or the lot would be below the minimum', () => {
    expect(planOrder(plan(), { tick: null, spec, balance: 10000, pipSize: 0.1 })).toHaveProperty('error');
    expect(planOrder(plan({ riskPct: 0.001 }), { tick: { bid: 1, ask: 2 }, spec, balance: 10000, pipSize: 0.1 })).toHaveProperty('error');
    expect(planOrder(plan(), { tick: { bid: 1, ask: 2 }, spec: null, balance: 10000, pipSize: 0.1 })).toHaveProperty('error');
  });
});

describe('management rules in pips', () => {
  const buy = { ticket: 7, type: 'buy' as const, volume: 0.1, priceOpen: 2650, sl: 2643, tp: 2664 };
  const o = { pipSize: 0.1, spec };
  it('moves to breakeven + cushion once, only after the trigger, only toward profit', () => {
    expect(manageDecisions(buy, { bid: 2654, ask: 2654.2 }, rules(), { partialDone: false }, o)).toEqual([]);          // +40 pips: too early
    const a = manageDecisions(buy, { bid: 2655.2, ask: 2655.4 }, rules(), { partialDone: false }, o);                    // +52 pips
    expect(a).toEqual([{ kind: 'sl', ticket: 7, newSl: 2650.2, why: 'breakeven', text: expect.stringContaining('breakeven +2 pips') }]);
    expect(manageDecisions({ ...buy, sl: 2650.2 }, { bid: 2655.2, ask: 2655.4 }, rules(), { partialDone: false }, o)).toEqual([]); // already there
  });
  it('trails in steps and never loosens', () => {
    const r = rules({ breakeven: { enabled: false, triggerPips: 50, offsetPips: 2 }, trail: { enabled: true, startPips: 100, distancePips: 60, stepPips: 10 } });
    const a = manageDecisions({ ...buy, sl: 2650 }, { bid: 2662, ask: 2662.2 }, r, { partialDone: false }, o);          // +120 pips -> sl 2656
    expect(a[0]).toMatchObject({ kind: 'sl', newSl: 2656, why: 'trail' });
    expect(manageDecisions({ ...buy, sl: 2655.5 }, { bid: 2662, ask: 2662.2 }, r, { partialDone: false }, o)).toEqual([]); // less than one 10-pip step
    expect(manageDecisions({ ...buy, sl: 2658 }, { bid: 2662, ask: 2662.2 }, r, { partialDone: false }, o)).toEqual([]);   // would loosen
  });
  it('takes a partial once and mirrors for sells', () => {
    const r = rules({ partial: { enabled: true, atPips: 100, closePct: 50 }, breakeven: { enabled: false, triggerPips: 50, offsetPips: 2 } });
    const a = manageDecisions(buy, { bid: 2660.5, ask: 2660.7 }, r, { partialDone: false }, o);
    expect(a).toEqual([{ kind: 'partial', ticket: 7, volume: 0.05, text: expect.stringContaining('50%') }]);
    expect(manageDecisions(buy, { bid: 2660.5, ask: 2660.7 }, r, { partialDone: true }, o)).toEqual([]);
    const sell = { ticket: 8, type: 'sell' as const, volume: 0.1, priceOpen: 2650, sl: 2657, tp: null };
    const s = manageDecisions(sell, { bid: 2644.6, ask: 2644.8 }, rules(), { partialDone: false }, o); // +52 pips for the sell
    expect(s[0]).toMatchObject({ kind: 'sl', newSl: 2649.8 });
  });
});

describe('gate: the assistant acts only inside what was approved', () => {
  const tick = { bid: 2645, ask: 2645.2 };
  const base = (command: unknown, assistant?: { enabled: boolean; approvedPlanIds: string[] }, over: Partial<GateInput> = {}): GateInput => ({
    command: command as never, now: 1000, userConfirmed: true,
    settings: { tradingEnabled: true, risk: { maxRiskPerTradePct: 0.5, maxOpenRiskPct: 1.5, maxDailyLossPct: 2, dailyResetTimezone: 'UTC', maxSpread: 0.6, maxSlippage: 0.5, maxSimultaneousPositions: 3, missingSlPolicy: 'block', dailyLimitPolicy: 'manage_only', countFloatingInDailyLimit: true } as never, aiPermissions: {} as never, allowedSymbols: ['GOLD'], allowLive: false, ...(assistant ? { assistant } : {}) },
    killSwitch: false, account: { demo: true, balance: 10000, currency: 'USD' }, spec: { ...spec, point: 0.01 }, tick,
    positions: [{ ticket: 7, time: 1, symbol: 'GOLD', type: 'buy', volume: 0.1, priceOpen: 2650, priceCurrent: 2655, sl: 2643, tp: null, swap: 0, profit: 50, magic: 0, comment: '' } as never], orders: [], dailyRealizedPnl: 0, unresolved: [], ...over,
  });
  const env = { commandId: 'rule-1234567890', actor: 'rule', createdAt: 1, expiresAt: 5000, symbol: 'GOLD' };
  const open = (planId?: string): OpenMarketCommand => ({ ...env, type: 'open_market', side: 'buy', volume: 0.04, sl: 2638, tp: 2659, deviationPoints: 20, ...(planId ? { planId } : {}) } as never);
  const rules1 = (r: { failed: { rule: string } | null }) => r.failed?.rule;

  it('is blocked while the assistant is off or paused', () => {
    expect(rules1(evaluateGate(base(open('p1'))))).toBe('assistant_off');
    expect(evaluateGate(base(open('p1'), { enabled: true, approvedPlanIds: ['p1'] }, { killSwitch: true })).failures.map((f) => f.rule)).toContain('kill_switch');
  });
  it('opens only for an approved plan', () => {
    expect(evaluateGate(base(open('p1'), { enabled: true, approvedPlanIds: ['p1'] })).failures.map((f) => f.rule)).not.toContain('plan_not_approved');
    expect(evaluateGate(base(open('p2'), { enabled: true, approvedPlanIds: ['p1'] })).failures.map((f) => f.rule)).toContain('plan_not_approved');
    expect(evaluateGate(base(open(), { enabled: true, approvedPlanIds: ['p1'] })).failures.map((f) => f.rule)).toContain('plan_not_approved');
  });
  it('may move a stop toward profit, never back, never remove it, never touch the take profit', () => {
    const on = { enabled: true, approvedPlanIds: [] as string[] };
    const mod = (extra: object) => base({ ...env, type: 'modify_sltp', ticket: 7, ticketKind: 'position', ...extra }, on, { tick: { bid: 2655.2, ask: 2655.4 } });
    expect(evaluateGate(mod({ sl: 2650.2 })).failures).toEqual([]);
    expect(evaluateGate(mod({ sl: 2640 })).failures.map((f) => f.rule)).toContain('rule_widens_risk');
    expect(evaluateGate(mod({ sl: null })).failures.map((f) => f.rule)).toContain('rule_not_allowed');
    expect(evaluateGate(mod({ sl: 2650.2, tp: 2670 })).failures.map((f) => f.rule)).toContain('rule_not_allowed');
  });
  it('cannot run bulk close or cancel orders on its own', () => {
    expect(evaluateGate(base({ ...env, type: 'close_all' }, { enabled: true, approvedPlanIds: [] })).failures.map((f) => f.rule)).toContain('rule_not_allowed');
  });
});
