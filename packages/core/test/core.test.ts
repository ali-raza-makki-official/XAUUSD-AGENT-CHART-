import { describe, expect, it } from 'vitest';
import {
  IdempotencyRegistry,
  applyTick,
  barStart,
  canTransition,
  floorToStep,
  isExpired,
  lossPerLot,
  lotsForRisk,
  priceToPips,
  type ContractSpec,
  DEFAULT_APP_CONFIG,
  AiPermissionsSchema,
} from '../src';

const gold: ContractSpec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 };

describe('risk', () => {
  it('50-100 pip SL on gold is 5-10 USD of price, ~500-1000 USD per lot', () => {
    expect(lossPerLot(gold, 5)).toBeCloseTo(500);
    expect(lossPerLot(gold, 10)).toBeCloseTo(1000);
    expect(priceToPips(5)).toBeCloseTo(50);
  });
  it('sizes lots from risk % and never rounds up past the budget', () => {
    const r = lotsForRisk({ balance: 10000, riskPct: 0.5, slDistance: 7.5, spec: gold });
    expect(r.riskBudget).toBe(50);
    expect(r.lots).toBe(0.06); // 50/750 = 0.0666 -> 0.06
    expect(r.actualRisk).toBeLessThanOrEqual(50);
  });
  it('includes commission and spread in per-lot cost', () => {
    const a = lotsForRisk({ balance: 10000, riskPct: 1, slDistance: 5, spec: gold });
    const b = lotsForRisk({ balance: 10000, riskPct: 1, slDistance: 5, spec: gold, commissionPerLot: 7, spreadCostPerLot: 20 });
    expect(b.lots).toBeLessThanOrEqual(a.lots);
  });
  it('blocks when the budget cannot afford the minimum volume', () => {
    const r = lotsForRisk({ balance: 100, riskPct: 0.5, slDistance: 10, spec: gold });
    expect(r.blocked).toBe('below_min_volume');
    expect(r.lots).toBe(0);
  });
  it('blocks invalid input (no SL)', () => {
    expect(lotsForRisk({ balance: 1000, riskPct: 1, slDistance: 0, spec: gold }).blocked).toBe('invalid_input');
  });
  it('floorToStep avoids float drift', () => {
    expect(floorToStep(0.0699999, 0.01)).toBe(0.06);
    expect(floorToStep(0.07, 0.01)).toBe(0.07);
  });
});

describe('commands', () => {
  it('duplicate command id returns the first result and does not re-create', () => {
    const reg = new IdempotencyRegistry<{ n: number }>();
    let calls = 0;
    const a = reg.register('cmd-12345678', () => ({ n: ++calls }));
    const b = reg.register('cmd-12345678', () => ({ n: ++calls }));
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(calls).toBe(1);
    expect(b.record).toBe(a.record);
  });
  it('expires commands', () => {
    expect(isExpired({ expiresAt: 1000 }, 999)).toBe(false);
    expect(isExpired({ expiresAt: 1000 }, 1000)).toBe(true);
  });
  it('order state machine forbids blind resend paths', () => {
    expect(canTransition('requested', 'sent_to_broker')).toBe(true);
    expect(canTransition('sent_to_broker', 'unknown_reconcile')).toBe(true);
    expect(canTransition('unknown_reconcile', 'sent_to_broker')).toBe(false);
    expect(canTransition('rejected', 'confirmed')).toBe(false);
  });
});

describe('feed helpers', () => {
  it('barStart aligns to the timeframe', () => {
    expect(barStart(1000, 'M15')).toBe(900);
  });
  it('applyTick updates the open bar and opens a new one', () => {
    const c = [{ time: 900, open: 10, high: 11, low: 9, close: 10, volume: 0 }];
    const t = (time: number, bid: number) => ({ symbol: 'GOLD', bid, ask: bid + 0.2, time, spread: 0.2 });
    const u = applyTick(c, t(1000, 12), 'M15');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ high: 12, close: 12, open: 10 });
    const n = applyTick(u, t(1801, 8), 'M15');
    expect(n).toHaveLength(2);
    expect(n[1]).toMatchObject({ time: 1800, open: 8 });
    expect(applyTick(n, t(100, 5), 'M15')).toBe(n);
  });
});

describe('defaults are on the safe side', () => {
  it('AI starts read-only for orders and edits', () => {
    const p = AiPermissionsSchema.parse({});
    expect(p.orders).toBe('suggest');
    expect(p.sltpAndPartialClose).toBe(false);
    expect(p.bulkClose).toBe(false);
  });
  it('daily limit keeps positions manageable, not auto-closed', () => {
    expect(DEFAULT_APP_CONFIG.risk.dailyLimitPolicy).toBe('manage_only');
    expect(DEFAULT_APP_CONFIG.brokerSymbol).toBe('GOLD');
  });
});
