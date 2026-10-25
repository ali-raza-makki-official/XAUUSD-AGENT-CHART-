import { describe, expect, it } from 'vitest';
import { composeBriefing, type BriefingInput } from '../src';

const base: BriefingInput = {
  nowMs: Date.UTC(2026, 9, 21, 7, 0), symbol: 'XAUUSD', tick: { bid: 2650.1, ask: 2650.3 }, sessions: null, events: null, openPositions: null, yesterday: null,
  currency: 'USD', myView: null, aiView: null, showMoney: true, tz: 'UTC',
};

describe('composeBriefing', () => {
  it('leaves out what it does not know and says so for news', () => {
    const t = composeBriefing(base);
    expect(t).toContain('*Good morning. Wednesday 21 Oct*');
    expect(t).toContain('XAUUSD: 2650.10 / 2650.30');
    expect(t).toContain('no economic calendar connected');
    expect(t).not.toContain('Positions');
    expect(t).not.toContain('Yesterday');
  });
  it('lists real events, positions and yesterday, and hides money when asked', () => {
    const input: BriefingInput = {
      ...base, events: [{ time: Date.UTC(2026, 9, 21, 12, 30) / 1000, title: 'US CPI', currency: 'USD', impact: 'high' } as never],
      openPositions: [{ side: 'buy', volume: 0.1, sl: 2640, tp: null, profit: 12.5 }], yesterday: { trades: 3, net: -20, wins: 1 },
    };
    const shown = composeBriefing(input);
    expect(shown).toContain('- 12:30 USD US CPI');
    expect(shown).toContain('- Buy 0.1 lot, SL 2640, TP none, +12.50 USD');
    expect(shown).toContain('3 trade(s), 1 won, net -20.00 USD');
    const hidden = composeBriefing({ ...input, showMoney: false });
    expect(hidden).not.toMatch(/12\.50|-20\.00/);
  });
  it('says when there is no live price', () => {
    expect(composeBriefing({ ...base, tick: null })).toContain('no live price');
  });
});
