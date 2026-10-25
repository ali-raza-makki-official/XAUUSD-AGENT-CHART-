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

import { aggregateCandles, nextBarStart, TIMEFRAMES, TIMEFRAME_SECONDS } from '../src';

describe('all MT5 timeframes', () => {
  it('has a length for every period and aligns bars like MT5', () => {
    for (const tf of TIMEFRAMES) expect(TIMEFRAME_SECONDS[tf]).toBeGreaterThan(0);
    const t = Date.UTC(2026, 9, 21, 10, 37, 20) / 1000; // Wed 2026-10-21 10:37:20
    expect(barStart(t, 'M10')).toBe(Date.UTC(2026, 9, 21, 10, 30) / 1000);
    expect(barStart(t, 'H3')).toBe(Date.UTC(2026, 9, 21, 9, 0) / 1000);
    expect(barStart(t, 'H12')).toBe(Date.UTC(2026, 9, 21, 0, 0) / 1000);
    expect(barStart(t, 'W1')).toBe(Date.UTC(2026, 9, 18, 0, 0) / 1000); // Sunday
    expect(new Date(barStart(t, 'W1') * 1000).getUTCDay()).toBe(0);
    expect(barStart(t, 'MN1')).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(nextBarStart(Date.UTC(2026, 1, 1) / 1000, 'MN1')).toBe(Date.UTC(2026, 2, 1) / 1000); // February is 28 days
  });

  it('builds M13, M45 and Y1 from real base candles', () => {
    const c = (time: number, o: number, h: number, l: number, cl: number, volume = 1) => ({ time, open: o, high: h, low: l, close: cl, volume });
    const t0 = Math.floor(Date.UTC(2026, 0, 5, 10, 0) / 1000 / 2700) * 2700; // a 45-minute boundary
    const m45 = aggregateCandles([c(t0, 10, 12, 9, 11), c(t0 + 900, 11, 15, 10, 14), c(t0 + 1800, 14, 14.5, 8, 9), c(t0 + 2700, 9, 9.5, 8.5, 9.2)], 'M45');
    expect(m45).toEqual([{ time: t0, open: 10, high: 15, low: 8, close: 9, volume: 3 }, { time: t0 + 2700, open: 9, high: 9.5, low: 8.5, close: 9.2, volume: 1 }]);
    const y = aggregateCandles([c(Date.UTC(2025, 11, 1) / 1000, 1, 2, 0.5, 1.5), c(Date.UTC(2026, 0, 1) / 1000, 1.5, 3, 1, 2)], 'Y1');
    expect(y.map((k) => new Date(k.time * 1000).getUTCFullYear())).toEqual([2025, 2026]);
    expect(barStart(Date.UTC(2026, 6, 4) / 1000, 'Y1')).toBe(Date.UTC(2026, 0, 1) / 1000);
    expect(nextBarStart(Date.UTC(2026, 0, 1) / 1000, 'Y1')).toBe(Date.UTC(2027, 0, 1) / 1000);
  });
});
