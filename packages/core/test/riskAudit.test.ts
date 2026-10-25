import { describe, expect, it } from 'vitest';
import { evaluateGate, judgeEvidence, type Evidence, type GateInput } from '../src';

const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 0.01 };
const pos = (ticket: number, sl: number, symbol = 'GOLD') => ({ ticket, time: 1, symbol, type: 'buy', volume: 0.1, priceOpen: 2650, priceCurrent: 2655, sl, tp: null, swap: 0, profit: 0, magic: 0, comment: '' } as never);
const gate = (command: object, over: Partial<GateInput> = {}): GateInput => ({
  command: { commandId: 'manual-1234567890', actor: 'manual', createdAt: 1, expiresAt: 5000, symbol: 'GOLD', ...command } as never, now: 1000, userConfirmed: true,
  settings: { tradingEnabled: true, risk: { maxRiskPerTradePct: 1, maxOpenRiskPct: 1.5, maxDailyLossPct: 5, dailyResetTimezone: 'UTC', maxSpread: 0.6, maxSlippage: 0.5, maxSimultaneousPositions: 5, missingSlPolicy: 'block', dailyLimitPolicy: 'manage_only', countFloatingInDailyLimit: true } as never, aiPermissions: {} as never, allowedSymbols: ['GOLD'], allowLive: false },
  killSwitch: false, account: { demo: true, balance: 10000, currency: 'USD' }, spec, tick: { bid: 2655, ask: 2655.2 }, positions: [], orders: [], dailyRealizedPnl: 0, unresolved: [], ...over,
});
const rules = (r: ReturnType<typeof evaluateGate>) => r.failures.map((f) => f.rule);

describe('audit: risk gate', () => {
  it('a stop that widens one trade cannot break the total open-risk maximum', () => {
    const positions = [pos(1, 2645), pos(2, 2645), pos(3, 2645)]; // 50 each = 150 = the 1.5% maximum
    expect(rules(evaluateGate(gate({ type: 'modify_sltp', ticket: 3, ticketKind: 'position', sl: 2640 }, { positions })))).toContain('open_risk'); // risk 100 -> total 200
    expect(rules(evaluateGate(gate({ type: 'modify_sltp', ticket: 3, ticketKind: 'position', sl: 2646 }, { positions })))).not.toContain('open_risk'); // toward safety stays allowed
  });
  it('blocks new orders on a frozen price but never blocks closing', () => {
    const open = { type: 'open_market', side: 'buy', volume: 0.01, sl: 2650, tp: null, deviationPoints: 20 };
    expect(rules(evaluateGate(gate(open, { tick: { bid: 2655, ask: 2655.2, ageMs: 120_000 } })))).toContain('stale_quote');
    expect(rules(evaluateGate(gate(open, { tick: { bid: 2655, ask: 2655.2, ageMs: 2_000 } })))).not.toContain('stale_quote');
    expect(rules(evaluateGate(gate({ type: 'close_position', ticket: 1 }, { positions: [pos(1, 2649)], tick: { bid: 2655, ask: 2655.2, ageMs: 999_999 } })))).toEqual([]);
  });
  it('only manages positions on the configured gold symbol, and will not value foreign exposure', () => {
    const eur = pos(9, 1.1, 'EURUSD');
    expect(rules(evaluateGate(gate({ type: 'close_position', ticket: 9 }, { positions: [eur] })))).toContain('symbol_not_allowed');
    expect(rules(evaluateGate(gate({ type: 'modify_sltp', ticket: 9, ticketKind: 'position', sl: 1.2 }, { positions: [eur] })))).toContain('symbol_not_allowed');
    expect(rules(evaluateGate(gate({ type: 'open_market', side: 'buy', volume: 0.01, sl: 2650, tp: null, deviationPoints: 20 }, { positions: [eur] })))).toContain('open_risk');
  });
});

describe('audit: evidence', () => {
  const ev = (over: Partial<Evidence>): Evidence => ({ tag: 't', queried: { positions: true, orders: true, deals: true, historyOrders: false }, positions: [], orders: [], deals: [], historyOrders: [], target: null, ...over });
  const rec = (command: object) => ({ command: command as never, broker: null, volumeBefore: null });
  it('a matching open position confirms a market order even though order history is not queried', () => {
    expect(judgeEvidence(rec({ type: 'open_market' }), ev({ positions: [pos(5, 2649)] })).verdict).toBe('confirmed');
  });
  it('no trace of a market order is conclusive, but a missing pending order is not without order history', () => {
    expect(judgeEvidence(rec({ type: 'open_market' }), ev({})).verdict).toBe('no_trace');
    expect(judgeEvidence(rec({ type: 'open_pending' }), ev({})).verdict).toBe('inconclusive');
    expect(judgeEvidence(rec({ type: 'open_pending' }), ev({ queried: { positions: true, orders: true, deals: true, historyOrders: true } })).verdict).toBe('no_trace');
  });
  it('unqueried positions, orders or deals are always inconclusive', () => {
    expect(judgeEvidence(rec({ type: 'open_market' }), ev({ queried: { positions: true, orders: true, deals: false, historyOrders: false } })).verdict).toBe('inconclusive');
  });
});
