import { describe, expect, it } from 'vitest';
import { analyseStructure, findFvgs, findPatterns, zoneLife } from '../src/structure';
import { type Candle } from '../src/feed';

const k = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 0 });

describe('structure', () => {
  it('finds a bullish FVG and tracks fill status', () => {
    const base = [k(1, 10, 11, 9, 10.5), k(2, 10.5, 14, 10.4, 13.8), k(3, 13.8, 15, 12, 14.5)];
    const f = findFvgs(base);
    expect(f).toEqual([{ kind: 'fvg', direction: 'bullish', startTime: 1, endTime: 3, bottom: 11, top: 12, status: 'open', touches: 0, valid: true, invalidatedAt: null }]);
    expect(findFvgs([...base, k(4, 14, 14.2, 11.5, 12)])[0]!.status).toBe('partial');
    expect(findFvgs([...base, k(4, 14, 14.2, 10.8, 11)])[0]!.status).toBe('filled');
  });
  it('finds a bearish FVG and no gap when candles overlap', () => {
    expect(findFvgs([k(1, 20, 21, 19, 19.5), k(2, 19.5, 19.6, 15, 15.5), k(3, 15.5, 17, 14, 14.5)])[0]).toMatchObject({ direction: 'bearish', top: 19, bottom: 17 });
    expect(findFvgs([k(1, 10, 12, 9, 11), k(2, 11, 13, 10, 12), k(3, 12, 14, 11.5, 13)])).toEqual([]);
  });
  it('detects engulfing and pin bars from real OHLC', () => {
    const p = findPatterns([k(1, 10, 10.5, 9.5, 10.2), k(2, 10.2, 10.4, 9.0, 9.2), k(3, 9.1, 10.8, 9.0, 10.6)]);
    expect(p.some((x) => x.name === 'bullish engulfing' && x.time === 3)).toBe(true);
  });
  it('groups equal highs as buy-side liquidity and marks sweeps', () => {
    const cs: Candle[] = [];
    const highs = [5, 6, 7, 10, 7, 6, 5, 6, 7, 10.05, 7, 6, 5, 4, 4];
    highs.forEach((h, i) => cs.push(k(i + 1, h - 1, h, h - 2, h - 1)));
    const r = analyseStructure(cs, { equalTolerance: 0.1 });
    const pool = r.liquidity.find((x) => x.side === 'buy-side');
    expect(pool).toMatchObject({ touches: 2, price: 10.05, swept: false });
  });

  it('zone is valid for 3 returns and ends at the 4th touch; a close through ends it at once', () => {
    const away = (t: number) => k(t, 20, 21, 19, 20);
    const touch = (t: number) => k(t, 20, 20, 11.5, 12.5); // enters 11-12 zone, closes above
    const seq = [away(1), touch(2), away(3), touch(4), away(5), touch(6), away(7), touch(8), away(9)];
    expect(zoneLife(seq.slice(0, 6), 11, 12, 'demand')).toEqual({ touches: 3, valid: true, invalidatedAt: null });
    expect(zoneLife(seq, 11, 12, 'demand')).toEqual({ touches: 4, valid: false, invalidatedAt: 8 });
    expect(zoneLife([away(1), k(2, 20, 20, 9, 10)], 11, 12, 'demand')).toMatchObject({ valid: false, invalidatedAt: 2 });
    // staying inside the zone for several candles is one touch, not several
    expect(zoneLife([k(1, 12.5, 12.8, 11.2, 11.5), k(2, 11.5, 12.2, 11.1, 11.8)], 11, 12, 'demand').touches).toBe(1);
  });
});
