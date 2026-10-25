import { describe, expect, it } from 'vitest';
import { behaviorFlags, type ClosedTrade } from '../src';

let id = 0;
const t = (open: number, close: number, net: number, volume = 0.1): ClosedTrade => ({ positionId: ++id, symbol: 'GOLD', side: 'buy', openTime: open, closeTime: close, volume, net, heldSec: close - open });
const T = 1_760_000_000;

describe('behaviour flags', () => {
  it('flags size-up and quick re-entry after a loss, with the trades involved', () => {
    const a = t(T, T + 600, -20, 0.1), b = t(T + 840, T + 1500, -30, 0.2); // re-entered 4 min later with double size
    const flags = behaviorFlags([a, b]);
    expect(flags.map((f) => f.id).sort()).toEqual(['quick_reentry', 'size_up_after_loss']);
    expect(flags[0]!.positions).toEqual([b.positionId]);
  });
  it('does not flag a calm, normal sequence', () => {
    expect(behaviorFlags([t(T, T + 600, 20), t(T + 7200, T + 8000, -10), t(T + 20000, T + 21000, 15)])).toEqual([]);
  });
  it('flags a burst of trades and too many in a day', () => {
    const many = Array.from({ length: 7 }, (_, i) => t(T + i * 600, T + i * 600 + 300, 5));
    const ids = behaviorFlags(many).map((f) => f.id);
    expect(ids).toContain('overtrading_hour'); expect(ids).toContain('overtrading_day');
  });
  it('flags losers held much longer than winners', () => {
    const w = [0, 1, 2].map((i) => t(T + i * 100000, T + i * 100000 + 300, 10));
    const l = [3, 4, 5].map((i) => t(T + i * 100000, T + i * 100000 + 3000, -10));
    expect(behaviorFlags([...w, ...l]).map((f) => f.id)).toContain('losers_run');
  });
});
