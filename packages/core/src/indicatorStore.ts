import { z } from 'zod';
import { ActorSchema, ColorSchema, LineStyleSchema, type Actor } from './drawing';
import { TimeframeSchema, type Timeframe } from './feed';
import { INDICATORS, INDICATOR_TYPES, resolveParams, type IndicatorType } from './indicators';

/** Per-output overrides (e.g. the MACD signal line colour). Anything unset falls back to the instance style. */
export const OutputStyleSchema = z.object({
  color: ColorSchema.optional(),
  width: z.number().min(1).max(8).optional(),
  lineStyle: LineStyleSchema.optional(),
  visible: z.boolean().optional(),
  /** Histogram outputs only: colour of negative bars. */
  negColor: ColorSchema.optional(),
}).strict();
export type OutputStyle = z.infer<typeof OutputStyleSchema>;

export const IndicatorStyleSchema = z.object({
  color: ColorSchema,
  width: z.number().min(1).max(8),
  lineStyle: LineStyleSchema,
  outputs: z.record(z.string(), OutputStyleSchema),
});
export type IndicatorStyle = z.infer<typeof IndicatorStyleSchema>;

export const IndicatorSchema = z.object({
  id: z.string().min(1),
  type: z.enum(INDICATOR_TYPES),
  label: z.string().max(80),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  style: IndicatorStyleSchema,
  visible: z.boolean(),
  /** Timeframes on which this indicator is drawn; 'all' = every pane. */
  timeframes: z.union([z.literal('all'), z.array(TimeframeSchema)]),
  locked: z.boolean(),
  origin: z.object({
    by: ActorSchema,
    at: z.number(),
    commandId: z.string().optional(),
    reason: z.string().max(500).optional(),
  }),
}).superRefine((v, ctx) => {
  const r = resolveParams(v.type, v.params);
  if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error, path: ['params'] });
  const keys = INDICATORS[v.type].outputs.map((o) => o.key);
  for (const k of Object.keys(v.style.outputs)) {
    if (!keys.includes(k)) ctx.addIssue({ code: 'custom', message: `${INDICATORS[v.type].name} has no output '${k}'.`, path: ['style', 'outputs', k] });
  }
});
export type Indicator = z.infer<typeof IndicatorSchema>;

export const isIndicatorShownOn = (i: Pick<Indicator, 'visible' | 'timeframes'>, tf: Timeframe): boolean =>
  i.visible && (i.timeframes === 'all' || i.timeframes.includes(tf));

export interface MakeIndicatorOptions {
  id?: string;
  actor?: Actor;
  now?: number;
  commandId?: string;
  reason?: string;
  label?: string;
  params?: Record<string, unknown>;
  style?: Partial<Omit<IndicatorStyle, 'outputs'>> & { outputs?: Record<string, OutputStyle> };
  timeframes?: Indicator['timeframes'];
}

/** Build a valid indicator with defaults from the registry. Throws if the params are invalid. */
export function makeIndicator(type: IndicatorType, o: MakeIndicatorOptions = {}): Indicator {
  const def = INDICATORS[type];
  const resolved = resolveParams(type, o.params ?? {});
  if (!resolved.ok) throw new Error(resolved.error);
  const first = def.outputs[0]!;
  return IndicatorSchema.parse({
    id: o.id ?? globalThis.crypto.randomUUID(),
    type,
    label: o.label ?? '',
    params: resolved.params,
    style: { color: first.color, width: 2, lineStyle: 'solid', outputs: {}, ...o.style },
    visible: true,
    timeframes: o.timeframes ?? 'all',
    locked: false,
    origin: { by: o.actor ?? 'manual', at: o.now ?? Date.now(), commandId: o.commandId, reason: o.reason },
  });
}

export interface ResolvedOutputStyle { color: string; negColor: string | undefined; width: number; lineStyle: Indicator['style']['lineStyle']; visible: boolean }

/** Effective look of one output: per-output override, else registry colour (multi-output) or instance style. */
export function outputStyle(ind: Indicator, key: string): ResolvedOutputStyle {
  const def = INDICATORS[ind.type];
  const out = def.outputs.find((o) => o.key === key);
  const ov = ind.style.outputs[key] ?? {};
  // Single-output indicators follow the instance colour; multi-output ones keep their per-output default.
  const base = def.outputs.length === 1 ? ind.style.color : out?.color ?? ind.style.color;
  return {
    color: ov.color ?? base,
    negColor: ov.negColor ?? out?.negColor,
    width: ov.width ?? ind.style.width,
    lineStyle: ov.lineStyle ?? ind.style.lineStyle,
    visible: ov.visible ?? true,
  };
}

/** Short title such as "EMA 20" or "MACD 12/26/9". */
export function indicatorTitle(ind: Pick<Indicator, 'type' | 'params' | 'label'>): string {
  if (ind.label) return ind.label;
  const def = INDICATORS[ind.type];
  const nums = def.params.filter((p) => p.type !== 'select').map((p) => ind.params[p.key]);
  return nums.length ? `${def.name} ${nums.join('/')}` : def.name;
}

const PROTECTED = new Set(['id', 'type', 'origin']);

export type IndicatorOp =
  | { op: 'create'; indicator: Indicator }
  | { op: 'update'; id: string; patch: Record<string, unknown> }
  | { op: 'delete'; id: string };

export interface IndicatorCommand {
  commandId: string;
  actor: Actor;
  label: string;
  ops: IndicatorOp[];
}

export interface IndicatorChange { id: string; before: Indicator | null; after: Indicator | null }

export interface IndicatorHistoryEntry {
  commandId: string;
  actor: Actor;
  label: string;
  at: number;
  changes: IndicatorChange[];
}

export type IndicatorDispatchResult =
  | { ok: true; duplicate: boolean; entry: IndicatorHistoryEntry | null }
  | { ok: false; error: string };

export type IndicatorStoreEvent =
  | { type: 'changes'; entry: IndicatorHistoryEntry; direction: 'do' | 'undo' | 'redo' }
  | { type: 'loaded' };

/**
 * Single source of truth for indicator instances. The Indicators dialog, the inspector and the AI tools all call
 * dispatch(), so validation, locks, undo/redo and duplicate protection behave the same everywhere.
 */
export class IndicatorStore {
  private items = new Map<string, Indicator>();
  private undoStack: IndicatorHistoryEntry[] = [];
  private redoStack: IndicatorHistoryEntry[] = [];
  private seen = new Set<string>();
  private listeners = new Set<(e: IndicatorStoreEvent) => void>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Insertion order, which is also the pane order for indicators that get their own pane. */
  list(): Indicator[] { return [...this.items.values()]; }
  get(id: string): Indicator | undefined { return this.items.get(id); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  history(): readonly IndicatorHistoryEntry[] { return this.undoStack; }
  peekUndo(): IndicatorHistoryEntry | undefined { return this.undoStack.at(-1); }
  peekRedo(): IndicatorHistoryEntry | undefined { return this.redoStack.at(-1); }

  subscribe(fn: (e: IndicatorStoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: IndicatorStoreEvent) { this.listeners.forEach((l) => l(e)); }

  load(items: Indicator[], seenCommandIds: Iterable<string> = []): void {
    this.items = new Map(items.map((d) => [d.id, d]));
    this.undoStack = [];
    this.redoStack = [];
    this.seen = new Set(seenCommandIds);
    this.emit({ type: 'loaded' });
  }

  dispatch(cmd: IndicatorCommand): IndicatorDispatchResult {
    if (this.seen.has(cmd.commandId)) return { ok: true, duplicate: true, entry: null };
    const planned = this.plan(cmd);
    if (!planned.ok) return planned;
    if (planned.changes.length === 0) return { ok: true, duplicate: false, entry: null };
    const entry: IndicatorHistoryEntry = { commandId: cmd.commandId, actor: cmd.actor, label: cmd.label, at: this.now(), changes: planned.changes };
    this.apply(entry.changes, 'after');
    this.seen.add(cmd.commandId);
    this.undoStack.push(entry);
    this.redoStack = [];
    this.emit({ type: 'changes', entry, direction: 'do' });
    return { ok: true, duplicate: false, entry };
  }

  private plan(cmd: IndicatorCommand): { ok: true; changes: IndicatorChange[] } | { ok: false; error: string } {
    const scratch = new Map(this.items);
    const first = new Map<string, Indicator | null>();
    const remember = (id: string) => { if (!first.has(id)) first.set(id, this.items.get(id) ?? null); };

    for (const op of cmd.ops) {
      if (op.op === 'create') {
        const parsed = IndicatorSchema.safeParse(op.indicator);
        if (!parsed.success) return { ok: false, error: `Invalid indicator: ${parsed.error.issues[0]?.message ?? 'schema'}` };
        const d = parsed.data;
        if (scratch.has(d.id)) return { ok: false, error: `Indicator ${d.id} already exists.` };
        if (cmd.actor === 'ai' && d.origin.by !== 'ai') return { ok: false, error: 'AI indicators must be marked as created by the AI.' };
        remember(d.id);
        scratch.set(d.id, d);
        continue;
      }
      const cur = scratch.get(op.id);
      if (!cur) return { ok: false, error: `Indicator ${op.id} not found.` };
      if (cmd.actor === 'ai' && cur.locked) return { ok: false, error: `Indicator ${op.id} is locked; the AI may not change it.` };
      remember(op.id);
      if (op.op === 'delete') { scratch.delete(op.id); continue; }
      const bad = Object.keys(op.patch).find((k) => PROTECTED.has(k));
      if (bad) return { ok: false, error: `Field '${bad}' cannot be changed.` };
      if (cmd.actor === 'ai' && 'locked' in op.patch) return { ok: false, error: 'The AI may not lock or unlock indicators.' };
      const patch = { ...op.patch } as Record<string, unknown>;
      if (patch.params && typeof patch.params === 'object') patch.params = { ...cur.params, ...(patch.params as object) };
      if (patch.style && typeof patch.style === 'object') {
        const s = patch.style as Record<string, unknown>;
        const outs = s.outputs && typeof s.outputs === 'object' ? s.outputs as Record<string, object> : undefined;
        const mergedOuts: Record<string, object> = { ...cur.style.outputs };
        if (outs) for (const [k, v] of Object.entries(outs)) mergedOuts[k] = { ...(mergedOuts[k] ?? {}), ...v };
        patch.style = { ...cur.style, ...s, outputs: mergedOuts };
      }
      const merged = IndicatorSchema.safeParse({ ...cur, ...patch });
      if (!merged.success) return { ok: false, error: `Invalid change: ${merged.error.issues[0]?.message ?? 'schema'}` };
      scratch.set(op.id, merged.data);
    }
    const changes: IndicatorChange[] = [];
    for (const [id, before] of first) {
      const after = scratch.get(id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ id, before, after });
    }
    return { ok: true, changes };
  }

  private apply(changes: IndicatorChange[], side: 'before' | 'after') {
    for (const c of changes) {
      const target = c[side];
      if (target) this.items.set(c.id, target);
      else this.items.delete(c.id);
    }
  }

  undo(): IndicatorHistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.apply(entry.changes, 'before');
    this.redoStack.push(entry);
    this.emit({ type: 'changes', entry, direction: 'undo' });
    return entry;
  }

  redo(): IndicatorHistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.apply(entry.changes, 'after');
    this.undoStack.push(entry);
    this.emit({ type: 'changes', entry, direction: 'redo' });
    return entry;
  }
}

interface Undoable {
  canUndo: boolean;
  canRedo: boolean;
  peekUndo(): { at: number } | undefined;
  peekRedo(): { at: number } | undefined;
  undo(): unknown;
  redo(): unknown;
}

/**
 * One Ctrl+Z for drawings AND indicators: undo the newest action across both stores, redo the oldest undone one.
 * Returns which store acted, or null if there was nothing to do.
 */
export function undoNewest(stores: Undoable[]): Undoable | null {
  let best: Undoable | null = null;
  let at = -Infinity;
  for (const s of stores) {
    const e = s.peekUndo();
    if (e && e.at >= at) { best = s; at = e.at; }
  }
  if (!best) return null;
  best.undo();
  return best;
}

export function redoOldest(stores: Undoable[]): Undoable | null {
  let best: Undoable | null = null;
  let at = Infinity;
  for (const s of stores) {
    const e = s.peekRedo();
    if (e && e.at <= at) { best = s; at = e.at; }
  }
  if (!best) return null;
  best.redo();
  return best;
}
