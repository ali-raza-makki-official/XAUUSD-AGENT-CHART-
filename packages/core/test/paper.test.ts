import { describe, expect, it } from 'vitest';
import { PaperTradeSchema, buildPath, groupStats, paperStep, pathResult, rankCombos, type PaperTick, type PaperTrade } from '../src';

const trade = (o: Partial<PaperTrade> = {}): PaperTrade => PaperTradeSchema.parse({
  id: 'paper-123456', createdAt: 0, source: 'plan', side: 'buy', entry: 'touch', zone: { low: 2640, high: 2645 }, slPips: 70, tpPips: 140,
  expiresAt: 1e12, maxHoldMs: 1e9, status: 'pending', ...o,
});
const tk = (ts: number, bid: number, spread = 0.2): PaperTick => ({ ts, bid, ask: bid + spread });
const run = (t: PaperTrade, ticks: PaperTick[]) => ticks.reduce((cur, k) => paperStep(cur, k, 0.1), t);

describe('paper trades on real ticks', () => {
  it('enters at the ask when the zone is touched and exits at the target on the bid, spread included', () => {
    const t = run(trade(), [tk(1, 2650), tk(2, 2644.7), tk(3, 2650), tk(4, 2658.9), tk(5, 2659.1)]);
    expect(t.status).toBe('won');
    expect(t.openPrice).toBeCloseTo(2644.9, 5); // ask at the touch
    expect(t.tp).toBeCloseTo(2658.9, 5);        // +140 pips from the fill
    expect(t.resultPips).toBe(140);
    expect(t.mfePips).toBeGreaterThan(130);
  });
  it('a stop hit is a loss of exactly the stop; and a stop wins when one tick covers both', () => {
    const lost = run(trade(), [tk(1, 2644.7), tk(2, 2637.8)]);
    expect(lost).toMatchObject({ status: 'lost', resultPips: -70 });
    const gap = run(trade({ tpPips: 10 }), [tk(1, 2644.7), tk(2, 2600)]);
    expect(gap.status).toBe('lost'); // price gapped through everything: the stop is the honest answer
  });
  it('sells mirror: enter on the bid, exit on the ask', () => {
    const t = run(trade({ side: 'sell', zone: { low: 2660, high: 2665 }, slPips: 50, tpPips: 100 }), [tk(1, 2650), tk(2, 2660.1), tk(3, 2649.8, 0.2)]);
    expect(t.openPrice).toBeCloseTo(2660.1, 5);
    expect(t.status).toBe('won'); expect(t.resultPips).toBe(100);
  });
  it('limit entries fill at the zone edge; ideas expire if price never comes; slicing through the zone cancels a touch idea', () => {
    expect(run(trade({ entry: 'limit' }), [tk(1, 2650), tk(2, 2644.5)]).openPrice).toBe(2645);
    expect(run(trade({ expiresAt: 100 }), [tk(1, 2650), tk(200, 2650)]).status).toBe('expired');
    expect(run(trade(), [tk(1, 2650), tk(2, 2630)]).status).toBe('expired');
  });
  it('closes at market after the maximum holding time', () => {
    const t = run(trade({ maxHoldMs: 1000 }), [tk(1, 2644.7), tk(500, 2646), tk(1500, 2646.5)]);
    expect(t.status).toBe('timeout');
    expect(t.resultPips).toBeCloseTo((2646.5 - 2644.9) / 0.1, 0);
  });
  it('does nothing once finished', () => {
    const done = run(trade(), [tk(1, 2644.7), tk(2, 2637.8)]);
    expect(paperStep(done, tk(3, 2700), 0.1)).toBe(done);
  });
});

describe('statistics and what-if', () => {
  const closed = (id: string, side: 'buy' | 'sell', pips: number, session = 'London'): PaperTrade => trade({ id, side, status: pips > 0 ? 'won' : 'lost', resultPips: pips, tags: { session } });
  it('groups win rate and expectancy in pips', () => {
    const rows = groupStats([closed('paper-a1', 'buy', 100), closed('paper-a2', 'buy', -70), closed('paper-a3', 'sell', 100, 'Asia')], (t) => t.side);
    expect(rows.find((r) => r.key === 'buy')).toMatchObject({ n: 2, winRate: 50, expectancy: 15, profitFactor: 1.43 });
    expect(rows.find((r) => r.key === 'sell')).toMatchObject({ n: 1, winRate: 100, profitFactor: null });
  });
  it('tests other stop/target pairs on the path price really took', () => {
    // buy at 2650: rises 60 pips, falls back 90 pips below entry, then rises 200 pips
    const ticks = [tk(1, 2656), tk(2, 2641), tk(3, 2670)];
    const path = buildPath('buy', 2650, ticks, 0.1);
    expect(pathResult(path, 70, 140, 0)).toBe(-70);   // stopped out at the dip
    expect(pathResult(path, 100, 140, 0)).toBe(140);  // a wider stop survives and reaches the target
    expect(pathResult(path, 100, 50, 0)).toBe(50);    // the early +60 reaches a 50-pip target first
    const ranked = rankCombos([{ path, lastPips: 200 }], [70, 100], [50, 140]);
    expect(ranked[0]).toMatchObject({ slPips: 100, tpPips: 140, expectancy: 140 });
  });
});
