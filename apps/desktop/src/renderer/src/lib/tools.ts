import type { DrawingKind, Point } from '@aurum/core';

export type ToolId = 'cursor' | 'hline' | 'vline' | 'ray' | 'trendline' | 'channel' | 'zone' | 'fib' | 'long' | 'short' | 'measure' | 'text';

export interface ToolDef {
  id: ToolId;
  label: string;
  key?: string;
  /** Clicks needed to finish. */
  clicks: number;
  kind?: DrawingKind;
  /** Geometry from the clicked points. `pts` may be shorter than `clicks` while previewing. */
  build?: (pts: Point[]) => Record<string, unknown> | null;
}

/** Default take-profit ladder for the position tools (reward multiples of the risk, share closed at each). */
export const POSITION_LADDER = [{ r: 2, closePct: 50 }, { r: 3, closePct: 50 }];

function position(side: 'buy' | 'sell') {
  return (pts: Point[]): Record<string, unknown> | null => {
    const e = pts[0];
    if (!e) return null;
    const rawSl = pts[1]?.price ?? e.price + (side === 'buy' ? -1 : 1) * 3;
    // Keep the stop on the losing side even if the second click landed on the wrong side.
    const risk = Math.max(Math.abs(e.price - rawSl), 0.01);
    const dir = side === 'buy' ? 1 : -1;
    const sl = e.price - dir * risk;
    return {
      kind: 'position', side, entryTime: e.time, entry: e.price, stopLoss: sl,
      takeProfits: POSITION_LADDER.map((l) => ({ price: Number((e.price + dir * risk * l.r).toFixed(2)), closePct: l.closePct })),
    };
  };
}

export const TOOLS: ToolDef[] = [
  { id: 'cursor', label: 'Select / move', key: 'V', clicks: 0 },
  { id: 'hline', label: 'Horizontal line', key: 'H', clicks: 1, kind: 'hline', build: (p) => p[0] ? { kind: 'hline', price: p[0].price } : null },
  { id: 'vline', label: 'Vertical line', clicks: 1, kind: 'vline', build: (p) => p[0] ? { kind: 'vline', time: p[0].time } : null },
  { id: 'ray', label: 'Ray', key: 'R', clicks: 2, kind: 'ray', build: (p) => p.length >= 2 ? { kind: 'ray', a: p[0], b: p[1] } : null },
  { id: 'trendline', label: 'Trendline', key: 'T', clicks: 2, kind: 'trendline', build: (p) => p.length >= 2 ? { kind: 'trendline', a: p[0], b: p[1] } : null },
  { id: 'channel', label: 'Parallel channel', clicks: 3, kind: 'channel', build: (p) => p.length >= 2 ? { kind: 'channel', a: p[0], b: p[1], c: p[2] ?? { time: p[1]!.time, price: p[1]!.price - (p[0]!.price - p[1]!.price) * 0.5 - 1 } } : null },
  { id: 'zone', label: 'Zone (support / resistance / supply / demand)', key: 'Z', clicks: 2, kind: 'zone', build: (p) => p.length >= 2 ? { kind: 'zone', a: p[0], b: p[1] } : null },
  { id: 'fib', label: 'Fibonacci retracement', key: 'F', clicks: 2, kind: 'fib', build: (p) => p.length >= 2 ? { kind: 'fib', a: p[0], b: p[1] } : null },
  { id: 'long', label: 'Long position (entry, SL, TP)', key: 'B', clicks: 2, kind: 'position', build: position('buy') },
  { id: 'short', label: 'Short position (entry, SL, TP)', key: 'S', clicks: 2, kind: 'position', build: position('sell') },
  { id: 'measure', label: 'Measure (price, pips, bars)', key: 'M', clicks: 2, kind: 'measure', build: (p) => p.length >= 2 ? { kind: 'measure', a: p[0], b: p[1] } : null },
  { id: 'text', label: 'Text note', clicks: 1, kind: 'text', build: (p) => p[0] ? { kind: 'text', at: p[0], text: 'Note' } : null },
];

export const toolById = (id: ToolId): ToolDef => TOOLS.find((t) => t.id === id)!;
