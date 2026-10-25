import { describe, expect, it } from 'vitest';
import { closedTrades, summarize, type BrokerDeal } from '../src';

let n = 0;
const deal = (o: Partial<BrokerDeal>): BrokerDeal => ({ ticket: ++n, order: n, time: 0, type: 'buy', entry: 'in', positionId: 1, volume: 0.1, price: 2650, commission: 0, swap: 0, profit: 0, fee: 0, reason: '', symbol: 'GOLD', magic: 0, comment: '', ...o });
const trade = (pid: number, side: 'buy' | 'sell', open: number, close: number, profit: number, commission = -0.7) => [
  deal({ positionId: pid, type: side, entry: 'in', time: open, commission }),
  deal({ positionId: pid, type: side === 'buy' ? 'sell' : 'buy', entry: 'out', time: close, profit }),
];
const T = Date.UTC(2026, 9, 19, 9, 0) / 1000; // Monday 09:00

describe('performance from real deals', () => {
  const deals = [
    ...trade(1, 'buy', T, T + 3600, 30), ...trade(2, 'sell', T + 7200, T + 9000, -20), ...trade(3, 'buy', T + 10000, T + 11800, -10),
    ...trade(4, 'sell', T + 90000, T + 93600, 50),
    deal({ type: 'other', entry: 'in', positionId: 0, profit: 1000 }), // deposit, ignored
    deal({ positionId: 9, entry: 'in', time: T }),                       // still open, ignored
  ];
  const trades = closedTrades(deals);
  const s = summarize(trades);
  it('counts only closed trades and nets costs', () => {
    expect(trades.map((t) => [t.positionId, t.side, Math.round(t.net * 100) / 100])).toEqual([[1, 'buy', 29.3], [2, 'sell', -20.7], [3, 'buy', -10.7], [4, 'sell', 49.3]]);
    expect(s.trades).toBe(4); expect(s.wins).toBe(2); expect(s.losses).toBe(2);
  });
  it('computes the usual statistics', () => {
    expect(s.winRate).toBe(50);
    expect(s.net).toBe(47.2);
    expect(s.profitFactor).toBe(2.5); // 78.6 / 31.4
    expect(s.expectancy).toBe(11.8);
    expect(s.maxLossStreak).toBe(2); expect(s.maxWinStreak).toBe(1);
    expect(s.maxDrawdown).toBe(31.4);
    expect(s.avgHoldMin).toBe(45);
    expect(s.bySide.buy.trades).toBe(2);
  });
  it('is empty and null-safe with no trades', () => {
    const e = summarize([]);
    expect(e).toMatchObject({ trades: 0, winRate: null, profitFactor: null, expectancy: null, maxDrawdown: 0 });
  });
});
