import { z } from 'zod';
import { TimeframeSchema } from './feed';

/** Anchor on the chart: candle time (unix s) and price. Never pixels, so it survives zoom/resize/timeframe. */
export const PointSchema = z.object({ time: z.number(), price: z.number() });
export type Point = z.infer<typeof PointSchema>;

export const LineStyleSchema = z.enum(['solid', 'dashed', 'dotted']);
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const StyleSchema = z.object({
  color: ColorSchema,
  width: z.number().min(1).max(8),
  lineStyle: LineStyleSchema,
  fillOpacity: z.number().min(0).max(1),
});
export type Style = z.infer<typeof StyleSchema>;

export const LayerSchema = z.enum(['manual', 'ai']);
export type Layer = z.infer<typeof LayerSchema>;
export const ActorSchema = z.enum(['manual', 'ai']);
export type Actor = z.infer<typeof ActorSchema>;

const FibLevelSchema = z.object({
  ratio: z.number(),
  visible: z.boolean(),
  color: ColorSchema.optional(),
});
export type FibLevel = z.infer<typeof FibLevelSchema>;

const TakeProfitSchema = z.object({
  price: z.number(),
  /** Share of the position to close at this target. */
  closePct: z.number().min(0).max(100),
});
export type TakeProfit = z.infer<typeof TakeProfitSchema>;

const base = {
  id: z.string().min(1),
  label: z.string().max(80),
  note: z.string().max(1000),
  layer: LayerSchema,
  origin: z.object({
    by: ActorSchema,
    at: z.number(),
    commandId: z.string().optional(),
    /** Why the AI drew this (shown in the inspector). */
    reason: z.string().max(500).optional(),
  }),
  locked: z.boolean(),
  visible: z.boolean(),
  /** Timeframes on which this drawing is shown; 'all' = every timeframe. */
  timeframes: z.union([z.literal('all'), z.array(TimeframeSchema)]),
  showLabel: z.boolean(),
  style: StyleSchema,
};

export const DrawingSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('hline'), price: z.number() }),
  z.object({ ...base, kind: z.literal('vline'), time: z.number() }),
  z.object({ ...base, kind: z.literal('ray'), a: PointSchema, b: PointSchema }),
  z.object({ ...base, kind: z.literal('trendline'), a: PointSchema, b: PointSchema, extend: z.enum(['none', 'right', 'both']) }),
  z.object({ ...base, kind: z.literal('channel'), a: PointSchema, b: PointSchema, c: PointSchema }),
  z.object({
    ...base,
    kind: z.literal('zone'),
    a: PointSchema,
    b: PointSchema,
    zoneType: z.enum(['support', 'resistance', 'supply', 'demand', 'custom']),
    extendRight: z.boolean(),
  }),
  z.object({ ...base, kind: z.literal('fib'), a: PointSchema, b: PointSchema, levels: z.array(FibLevelSchema), extendRight: z.boolean() }),
  z.object({
    ...base,
    kind: z.literal('position'),
    side: z.enum(['buy', 'sell']),
    entryTime: z.number(),
    entry: z.number(),
    stopLoss: z.number(),
    takeProfits: z.array(TakeProfitSchema).max(5),
    /** Planned risk as % of balance; used to size lots with the deterministic risk engine. */
    riskPct: z.number().positive().max(100),
  }),
  z.object({ ...base, kind: z.literal('measure'), a: PointSchema, b: PointSchema }),
  z.object({ ...base, kind: z.literal('text'), at: PointSchema, text: z.string().max(500) }),
]);
export type Drawing = z.infer<typeof DrawingSchema>;
export type DrawingKind = Drawing['kind'];

export const DRAWING_KINDS: DrawingKind[] = [
  'hline', 'vline', 'ray', 'trendline', 'channel', 'zone', 'fib', 'position', 'measure', 'text',
];

export const DEFAULT_FIB_LEVELS: FibLevel[] = [
  { ratio: 0, visible: true },
  { ratio: 0.236, visible: false },
  { ratio: 0.382, visible: true },
  { ratio: 0.5, visible: true },
  { ratio: 0.618, visible: true },
  { ratio: 0.786, visible: true },
  { ratio: 1, visible: true },
  { ratio: 1.272, visible: false },
  { ratio: 1.618, visible: true },
  { ratio: 2.618, visible: false },
];

/** Customisable per-tool defaults (colour, thickness, line style, fill). */
export const DEFAULT_STYLES: Record<DrawingKind, Style> = {
  hline: { color: '#d4af5a', width: 1, lineStyle: 'solid', fillOpacity: 0 },
  vline: { color: '#a3abb5', width: 1, lineStyle: 'dashed', fillOpacity: 0 },
  ray: { color: '#d4af5a', width: 1, lineStyle: 'solid', fillOpacity: 0 },
  trendline: { color: '#d4af5a', width: 2, lineStyle: 'solid', fillOpacity: 0 },
  channel: { color: '#d4af5a', width: 1, lineStyle: 'solid', fillOpacity: 0.08 },
  zone: { color: '#d4af5a', width: 1, lineStyle: 'solid', fillOpacity: 0.14 },
  fib: { color: '#a3abb5', width: 1, lineStyle: 'solid', fillOpacity: 0.04 },
  position: { color: '#a3abb5', width: 1, lineStyle: 'solid', fillOpacity: 0.12 },
  measure: { color: '#a3abb5', width: 1, lineStyle: 'dashed', fillOpacity: 0.08 },
  text: { color: '#e6e9ed', width: 1, lineStyle: 'solid', fillOpacity: 0 },
};

/** AI-created objects use a distinct colour family so they are recognisable at a glance. */
export const AI_COLOR = '#7fa8f5';

export type DrawingGeometry = Omit<Drawing, keyof typeof base> & { kind: DrawingKind };

export interface MakeOptions {
  id?: string;
  actor?: Actor;
  now?: number;
  commandId?: string;
  reason?: string;
  label?: string;
  note?: string;
  style?: Partial<Style>;
  timeframes?: Drawing['timeframes'];
}

/** Build a complete, valid drawing from geometry plus optional overrides. */
export function makeDrawing(geometry: Record<string, unknown> & { kind: DrawingKind }, o: MakeOptions = {}): Drawing {
  const actor = o.actor ?? 'manual';
  const style = {
    ...DEFAULT_STYLES[geometry.kind],
    ...(actor === 'ai' && !o.style?.color ? { color: AI_COLOR } : {}),
    ...o.style,
  };
  const id = o.id ?? (globalThis.crypto?.randomUUID?.() ?? `d_${Math.random().toString(36).slice(2)}`);
  return DrawingSchema.parse({
    id,
    label: o.label ?? '',
    note: o.note ?? '',
    layer: actor,
    origin: { by: actor, at: o.now ?? Date.now(), commandId: o.commandId, reason: o.reason },
    locked: false,
    visible: true,
    timeframes: o.timeframes ?? 'all',
    showLabel: true,
    style,
    ...(geometry.kind === 'fib' ? { levels: DEFAULT_FIB_LEVELS, extendRight: true } : {}),
    ...(geometry.kind === 'trendline' ? { extend: 'none' } : {}),
    ...(geometry.kind === 'zone' ? { zoneType: 'custom', extendRight: false } : {}),
    ...(geometry.kind === 'position' ? { takeProfits: [], riskPct: 0.5 } : {}),
    ...geometry,
  });
}

export const isShownOn = (d: Drawing, tf: z.infer<typeof TimeframeSchema>): boolean =>
  d.visible && (d.timeframes === 'all' || d.timeframes.includes(tf));

/** Reward-to-risk of a position drawing for TP at `index` (price distance ratio). */
export function rewardRisk(d: Extract<Drawing, { kind: 'position' }>, tpPrice: number): number {
  const risk = Math.abs(d.entry - d.stopLoss);
  if (risk === 0) return 0;
  return Math.abs(tpPrice - d.entry) / risk;
}

/** A position drawing is coherent only if SL and TPs sit on the correct sides of entry. */
export function positionIssues(d: Extract<Drawing, { kind: 'position' }>): string[] {
  const out: string[] = [];
  const dir = d.side === 'buy' ? 1 : -1;
  if ((d.entry - d.stopLoss) * dir <= 0) out.push('Stop loss must be on the losing side of entry.');
  d.takeProfits.forEach((tp, i) => {
    if ((tp.price - d.entry) * dir <= 0) out.push(`TP${i + 1} must be on the winning side of entry.`);
  });
  const total = d.takeProfits.reduce((s, t) => s + t.closePct, 0);
  if (total > 100) out.push('Take-profit close percentages add up to more than 100%.');
  return out;
}
