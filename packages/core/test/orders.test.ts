import { describe, expect, it } from 'vitest';
import { AURUM_MAGIC, isValidVolume, partialCloseVolume, riskAtSl, sizeOrder, slMoveAllowedAfterLimit } from '../src';

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const steps = [0.01, 0.05, 0.1, 1];
const randSpec = () => {
  const volumeStep = steps[Math.floor(rnd() * steps.length)]!;
  return { contractSize: 100, tickSize: 0.01, tickValue: 0.5 + rnd() * 2, volumeMin: volumeStep, volumeMax: 100, volumeStep };
};

describe('order maths (property style, seeded)', () => {
  it('magic matches the bridge constant', () => expect(AURUM_MAGIC).toBe(1096041045));

  it('lot size is on the step, in range and never risks more than the budget', () => {
    for (let i = 0; i < 2000; i++) {
      const spec = randSpec();
      const balance = 1000 + rnd() * 200000, riskPct = 0.05 + rnd() * 3, dist = 0.5 + rnd() * 30;
      const r = sizeOrder({ balance, riskPct, entry: 3000, stopLoss: 3000 - dist, spec });
      if (r.blocked) continue;
      expect(isValidVolume(r.lots, spec)).toBe(true);
      expect(r.actualRisk).toBeLessThanOrEqual(r.riskBudget + 1e-9);
    }
  });

  it('wider SL never gives more lots', () => {
    for (let i = 0; i < 500; i++) {
      const spec = randSpec(), d = 1 + rnd() * 10;
      const a = sizeOrder({ balance: 50000, riskPct: 1, entry: 3000, stopLoss: 3000 - d, spec });
      const b = sizeOrder({ balance: 50000, riskPct: 1, entry: 3000, stopLoss: 3000 - d * 2, spec });
      expect(b.lots).toBeLessThanOrEqual(a.lots);
    }
  });

  it('partial close respects volume_step, stays below the position and leaves a valid remainder', () => {
    for (let i = 0; i < 3000; i++) {
      const spec = randSpec();
      const pos = Number((spec.volumeMin * (1 + Math.floor(rnd() * 400))).toFixed(2));
      const frac = [0.25, 0.5, 0.75, rnd()][Math.floor(rnd() * 4)]!;
      const v = partialCloseVolume(pos, frac, spec);
      if (v === null) continue;
      expect(isValidVolume(v, spec)).toBe(true);
      expect(v).toBeLessThan(pos);
      expect(pos - v).toBeGreaterThanOrEqual(spec.volumeMin - 1e-9);
    }
    const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.1, volumeMax: 100, volumeStep: 0.01 };
    expect(partialCloseVolume(0.15, 0.5, spec)).toBeNull(); // would leave dust below the minimum
    expect(partialCloseVolume(1, 1, spec)).toBeNull();
    expect(partialCloseVolume(1, 0.5, spec)).toBe(0.5);
  });

  it('SL cannot be widened (or removed) after the daily limit, but can move toward safety', () => {
    const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };
    expect(riskAtSl(spec, 'buy', 3000, 2990, 1)).toBe(1000);
    expect(slMoveAllowedAfterLimit(spec, 'buy', 3000, 1, 2990, 2985)).toBe(false);
    expect(slMoveAllowedAfterLimit(spec, 'buy', 3000, 1, 2990, null)).toBe(false);
    expect(slMoveAllowedAfterLimit(spec, 'buy', 3000, 1, 2990, 2995)).toBe(true);
    expect(slMoveAllowedAfterLimit(spec, 'buy', 3000, 1, 2990, 3002)).toBe(true);
    expect(slMoveAllowedAfterLimit(spec, 'sell', 3000, 1, 3010, 3015)).toBe(false);
    expect(slMoveAllowedAfterLimit(spec, 'sell', 3000, 1, 3010, 3005)).toBe(true);
  });
});
