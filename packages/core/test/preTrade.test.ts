import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECKLIST, evaluateChecklist, type ChecklistInput, type GateNumbers, type OpenMarketCommand } from '../src';

const cmd = (o: Partial<OpenMarketCommand> = {}): OpenMarketCommand => ({
  commandId: 'ord-1234567890', actor: 'manual', createdAt: 1, expiresAt: 2, symbol: 'GOLD', type: 'open_market', side: 'buy', volume: 0.1, sl: 2640, tp: 2670, deviationPoints: 20, ...o,
});
const nums = (o: Partial<GateNumbers> = {}): GateNumbers => ({ riskMoney: 50, riskPct: 0.5, openRiskMoney: 0, openRiskPct: 0, dailyStartBalance: 10000, dailyLimitMoney: 200, dailyUsedMoney: 20, dailyLimitHit: false, spread: 0.2, positions: 0, pendingOrders: 0, ...o });
const base = (o: Partial<ChecklistInput> = {}): ChecklistInput => ({
  command: cmd(), tick: { bid: 2649.8, ask: 2650 }, numbers: nums(), risk: { maxRiskPerTradePct: 0.5, maxSpread: 0.6 }, settings: DEFAULT_CHECKLIST,
  openSessions: ['london', 'newyork'], news: { inWindow: null, next: null }, consecutiveLosses: 0, nowMs: 0, ...o,
});
const st = (r: ReturnType<typeof evaluateChecklist>, id: string) => r.items.find((i) => i.id === id)!.status;

describe('pre-trade checklist', () => {
  it('passes a clean trade and needs no acknowledgement', () => {
    const r = evaluateChecklist(base());
    expect(r.items.every((i) => i.status === 'pass')).toBe(true);
    expect(r.needsAck).toBe(false);
    expect(r.items.find((i) => i.id === 'rr')!.detail).toMatch(/^2\.00 : 1/);
  });
  it('fails weak reward:risk, wrong session, news window, and asks for acknowledgement', () => {
    const r = evaluateChecklist(base({
      command: cmd({ tp: 2655 }), openSessions: ['tokyo'],
      news: { inWindow: { start: 0, end: 1, events: [{ time: 0, title: 'US CPI', currency: 'USD', impact: 'high' }] }, next: null },
    }));
    expect(st(r, 'rr')).toBe('fail'); expect(st(r, 'session')).toBe('fail'); expect(st(r, 'news')).toBe('fail');
    expect(r.needsAck).toBe(true);
  });
  it('never says pass when the data is missing', () => {
    const r = evaluateChecklist(base({ tick: null, news: null, consecutiveLosses: null, openSessions: null, command: cmd({ tp: null }), numbers: nums({ riskPct: null, spread: null, dailyUsedMoney: null }) }));
    for (const id of ['rr', 'risk', 'spread', 'session', 'news', 'streak', 'daily']) expect(st(r, id)).toBe('unknown');
    expect(r.needsAck).toBe(false); // unknown informs, it does not block
  });
  it('warns on a losing streak, upcoming news and a nearly used daily limit', () => {
    const r = evaluateChecklist(base({
      consecutiveLosses: 3, numbers: nums({ dailyUsedMoney: 160 }),
      news: { inWindow: null, next: { start: 20 * 60_000, end: 1, events: [{ time: 0, title: 'FOMC', currency: 'USD', impact: 'high' }] } },
    }));
    expect(st(r, 'streak')).toBe('warn'); expect(st(r, 'news')).toBe('warn'); expect(st(r, 'daily')).toBe('warn');
  });
  it('flags a missing stop loss and a pending order uses its own entry price', () => {
    expect(st(evaluateChecklist(base({ command: cmd({ sl: null }) })), 'sl')).toBe('fail');
    const pend = evaluateChecklist(base({ command: { ...cmd(), type: 'open_pending', orderType: 'buy_limit', price: 2645, sl: 2640, tp: 2660 } as never }));
    expect(pend.items.find((i) => i.id === 'rr')!.detail).toMatch(/^3\.00 : 1/);
  });
});
