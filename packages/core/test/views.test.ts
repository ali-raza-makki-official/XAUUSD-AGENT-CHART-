import { describe, expect, it } from 'vitest';
import { aiViewFromAnalysis, compareViews, type UserView } from '../src';

const user = (o: Partial<UserView> = {}): UserView => ({ bias: 'bullish', timeframe: 'H1', levels: [{ price: 2650, kind: 'support' }, { price: 2680, kind: 'resistance' }], invalidation: '', note: '', savedAt: 1, ...o });
const ai = (state: 'bullish' | 'bearish' | 'ranging' | 'unclear', prices: number[]) => aiViewFromAnalysis({
  noSetup: false, marketStructure: { state }, levels: prices.map((price) => ({ price, kind: 'support' as const })), invalidation: 'x', dataReference: { asOf: 't', timeframes: ['H1'] },
}, 2);

describe('compareViews', () => {
  it('matches levels within tolerance, nearest first, each level used once', () => {
    const c = compareViews(user(), ai('bullish', [2651.5, 2700]), 3);
    expect(c.bias).toBe('agree');
    expect(c.shared).toHaveLength(1);
    expect(c.shared[0]!.distance).toBe(1.5);
    expect(c.userOnly.map((l) => l.price)).toEqual([2680]);
    expect(c.aiOnly.map((l) => l.price)).toEqual([2700]);
  });
  it('calls opposite directions a disagreement and other differences a different read', () => {
    expect(compareViews(user(), ai('bearish', []), 3).bias).toBe('disagree');
    expect(compareViews(user(), ai('ranging', []), 3).bias).toBe('different_kind');
  });
  it('says what is missing instead of inventing a comparison', () => {
    expect(compareViews(null, ai('bullish', [1]), 3).summary).toMatch(/not written your view/);
    expect(compareViews(user(), null, 3).summary).toMatch(/not given an analysis/);
    expect(compareViews(null, null, 3).bias).toBe('missing');
  });
});
