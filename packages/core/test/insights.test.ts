import { describe, expect, it } from 'vitest';
import { PaperTradeSchema, buildPath, findings, suggestTuning, type PaperTrade, type PaperTick } from '../src';

const mk = (i: number, pips: number, session = 'London', side: 'buy' | 'sell' = 'buy'): PaperTrade => PaperTradeSchema.parse({
  id: `paper-${i}-xxxx`, createdAt: i, source: 'plan', side, entry: 'touch', slPips: 70, tpPips: 140, expiresAt: 1e12, maxHoldMs: 1e9,
  status: pips > 0 ? 'won' : 'lost', resultPips: pips, openedAt: i, tags: { session },
});

describe('findings', () => {
  it('stays honest with a small sample', () => {
    expect(findings([mk(1, 100)])[0]!.text).toMatch(/Only 1 finished paper trade/);
  });
  it('names groups that clearly differ from the average, with their size', () => {
    const london = Array.from({ length: 10 }, (_, i) => mk(i, 140));
    const asia = Array.from({ length: 10 }, (_, i) => mk(100 + i, -70, 'Asia'));
    const f = findings([...london, ...asia]);
    expect(f.some((x) => x.kind === 'good' && /Session "London".*10 trades/.test(x.text))).toBe(true);
    expect(f.some((x) => x.kind === 'bad' && /Session "Asia"/.test(x.text))).toBe(true);
  });
});

describe('suggestTuning', () => {
  // 40 buys: price dips 80 pips then rallies 250: a 70-pip stop dies, a 100+ stop reaches the target
  const path = (openedAt: number) => {
    const ticks: PaperTick[] = [{ ts: openedAt + 1, bid: 2642, ask: 2642.2 }, { ts: openedAt + 2, bid: 2675, ask: 2675.2 }];
    return { path: buildPath('buy', 2650, ticks, 0.1), lastPips: 250, openedAt };
  };
  const many = Array.from({ length: 40 }, (_, i) => path(i * 10));

  it('recommends a wider stop only when it also wins on trades it was not chosen from', () => {
    const t = suggestTuning(many, { slPips: 70, tpPips: 140 })!;
    expect(t.confident).toBe(true);
    expect(t.best.slPips).toBeGreaterThanOrEqual(100);
    expect(t.test.best.expectancy).toBeGreaterThan(t.test.current.expectancy);
  });
  it('is only a hint on a small sample, and says nothing when the current pair is already best', () => {
    const small = suggestTuning(many.slice(0, 10), { slPips: 70, tpPips: 140 })!;
    expect(small.confident).toBe(false);
    expect(small.reason).toMatch(/need 30/);
    const flat = Array.from({ length: 40 }, (_, i) => ({ path: buildPath('buy', 2650, [{ ts: i, bid: 2650, ask: 2650.2 }], 0.1), lastPips: 0, openedAt: i }));
    expect(suggestTuning(flat, { slPips: 70, tpPips: 140 })!.confident).toBe(false); // nothing to improve on: every pair gives 0
  });
  it('returns null with too little data to compare', () => {
    expect(suggestTuning(many.slice(0, 3), { slPips: 70, tpPips: 140 })).toBeNull();
  });
});
