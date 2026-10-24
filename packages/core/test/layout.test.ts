import { describe, expect, it } from 'vitest';
import { handleAt, handlePatch, hitDistance, layoutDrawing, makeDrawing, translatePatch, type Proj } from '../src';

// time 0..1000 -> x 0..1000, price 2000..2100 -> y 500..0 (higher price = smaller y)
const proj: Proj = {
  x: (t) => t, t: (x) => x,
  y: (p) => 500 - (p - 2000) * 5, p: (y) => 2000 + (500 - y) / 5,
  width: 1000, height: 500, pipSize: 0.1, tfSeconds: 900,
};

describe('layout', () => {
  it('hline is hit near its y and not far away', () => {
    const d = makeDrawing({ kind: 'hline', price: 2050 });
    const l = layoutDrawing(d, proj);
    expect(hitDistance(l, 300, 250)).toBe(0);
    expect(hitDistance(l, 300, 262)).toBe(12);
  });
  it('zone fills and is hit inside', () => {
    const d = makeDrawing({ kind: 'zone', a: { time: 100, price: 2060 }, b: { time: 300, price: 2040 } });
    const l = layoutDrawing(d, proj);
    expect(hitDistance(l, 200, 250)).toBeLessThan(1);
    expect(hitDistance(l, 600, 250)).toBeGreaterThan(100);
  });
  it('position shows SL/TP labels with pips and R multiples', () => {
    const d = makeDrawing({ kind: 'position', side: 'buy', entryTime: 100, entry: 2050, stopLoss: 2045, takeProfits: [{ price: 2060, closePct: 100 }] });
    const texts = layoutDrawing(d, proj).shapes.filter((s) => s.t === 'text').map((s) => (s as { text: string }).text).join('|');
    expect(texts).toContain('SL 2045.00');
    expect(texts).toContain('50 pips');
    expect(texts).toContain('2.0R');
  });
  it('fib places 0 at b and 1 at a', () => {
    const d = makeDrawing({ kind: 'fib', a: { time: 100, price: 2100 }, b: { time: 200, price: 2000 } });
    const texts = layoutDrawing(d, proj).shapes.filter((s) => s.t === 'text').map((s) => (s as { text: string }).text);
    expect(texts.some((t) => t.startsWith('0 (2000.00)'))).toBe(true);
    expect(texts.some((t) => t.startsWith('1 (2100.00)'))).toBe(true);
    expect(texts.some((t) => t.startsWith('0.5 (2050.00)'))).toBe(true);
  });
  it('measure reports pips, bars and direction', () => {
    const d = makeDrawing({ kind: 'measure', a: { time: 0, price: 2000 }, b: { time: 9000, price: 2010 } });
    const t = layoutDrawing(d, proj).shapes.find((s) => s.t === 'text') as { text: string };
    expect(t.text).toContain('+10.00');
    expect(t.text).toContain('100 pips');
    expect(t.text).toContain('10 bars');
  });
  it('AI drawings carry an AI text marker', () => {
    const d = makeDrawing({ kind: 'hline', price: 2050 }, { actor: 'ai', label: 'R1' });
    const t = layoutDrawing(d, proj).shapes.find((s) => s.t === 'text') as { text: string };
    expect(t.text).toContain('AI · R1');
  });
});

describe('editing helpers', () => {
  it('finds a handle and builds anchor patches', () => {
    const d = makeDrawing({ kind: 'trendline', a: { time: 100, price: 2010 }, b: { time: 400, price: 2090 } });
    const l = layoutDrawing(d, proj);
    const h = handleAt(l, 101, 449);
    expect(h?.key).toBe('a');
    expect(handlePatch(d, 'b', 500, 2095)).toEqual({ b: { time: 500, price: 2095 } });
  });
  it('translates every anchor, including position SL/TPs', () => {
    const d = makeDrawing({ kind: 'position', side: 'sell', entryTime: 100, entry: 2050, stopLoss: 2055, takeProfits: [{ price: 2040, closePct: 100 }] });
    expect(translatePatch(d, 50, 2)).toMatchObject({ entryTime: 150, entry: 2052, stopLoss: 2057, takeProfits: [{ price: 2042, closePct: 100 }] });
  });
  it('position handles move SL/TP by price only', () => {
    const d = makeDrawing({ kind: 'position', side: 'buy', entryTime: 100, entry: 2050, stopLoss: 2045, takeProfits: [{ price: 2060, closePct: 50 }, { price: 2070, closePct: 50 }] });
    expect(handlePatch(d, 'sl', 999, 2044)).toEqual({ stopLoss: 2044 });
    expect((handlePatch(d, 'tp1', 999, 2075) as any).takeProfits[1].price).toBe(2075);
  });
});
