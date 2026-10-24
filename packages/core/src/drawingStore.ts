import { DrawingSchema, type Actor, type Drawing } from './drawing';

/** Fields a patch may never change. */
const PROTECTED = new Set(['id', 'kind', 'layer', 'origin']);

export type DrawingOp =
  | { op: 'create'; drawing: Drawing }
  | { op: 'update'; id: string; patch: Record<string, unknown> }
  | { op: 'delete'; id: string };

/** One user/AI action. Several ops form a batch that is applied and undone as a whole. */
export interface DrawingCommand {
  commandId: string;
  actor: Actor;
  label: string;
  ops: DrawingOp[];
}

export interface Change { id: string; before: Drawing | null; after: Drawing | null }

export interface HistoryEntry {
  commandId: string;
  actor: Actor;
  label: string;
  at: number;
  changes: Change[];
}

export type DispatchResult =
  | { ok: true; duplicate: boolean; entry: HistoryEntry | null }
  | { ok: false; error: string };

export type StoreEvent = { type: 'changes'; entry: HistoryEntry; direction: 'do' | 'undo' | 'redo' } | { type: 'loaded' };

/**
 * Single source of truth for drawings. Manual tools, the AI and (later) WhatsApp all call dispatch(),
 * so locks, layers, undo/redo, batch undo and duplicate protection behave identically everywhere.
 */
export class DrawingStore {
  private items = new Map<string, Drawing>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private seen = new Set<string>();
  private listeners = new Set<(e: StoreEvent) => void>();
  constructor(private readonly now: () => number = Date.now) {}

  list(): Drawing[] { return [...this.items.values()]; }
  get(id: string): Drawing | undefined { return this.items.get(id); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  history(): readonly HistoryEntry[] { return this.undoStack; }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: StoreEvent) { this.listeners.forEach((l) => l(e)); }

  /** Replace everything (startup load). History starts empty. */
  load(drawings: Drawing[], seenCommandIds: Iterable<string> = []): void {
    this.items = new Map(drawings.map((d) => [d.id, d]));
    this.undoStack = [];
    this.redoStack = [];
    this.seen = new Set(seenCommandIds);
    this.emit({ type: 'loaded' });
  }

  dispatch(cmd: DrawingCommand): DispatchResult {
    if (this.seen.has(cmd.commandId)) return { ok: true, duplicate: true, entry: null };
    const planned = this.plan(cmd);
    if (!planned.ok) return planned;
    if (planned.changes.length === 0) return { ok: true, duplicate: false, entry: null };
    const entry: HistoryEntry = { commandId: cmd.commandId, actor: cmd.actor, label: cmd.label, at: this.now(), changes: planned.changes };
    this.apply(entry.changes, 'after');
    this.seen.add(cmd.commandId);
    this.undoStack.push(entry);
    this.redoStack = [];
    this.emit({ type: 'changes', entry, direction: 'do' });
    return { ok: true, duplicate: false, entry };
  }

  /** Validate every op on a scratch copy first, so a batch is all-or-nothing. */
  private plan(cmd: DrawingCommand): { ok: true; changes: Change[] } | { ok: false; error: string } {
    const scratch = new Map(this.items);
    const first = new Map<string, Drawing | null>();
    const remember = (id: string) => { if (!first.has(id)) first.set(id, this.items.get(id) ?? null); };

    for (const op of cmd.ops) {
      if (op.op === 'create') {
        const parsed = DrawingSchema.safeParse(op.drawing);
        if (!parsed.success) return { ok: false, error: `Invalid drawing: ${parsed.error.issues[0]?.message ?? 'schema'}` };
        const d = parsed.data;
        if (scratch.has(d.id)) return { ok: false, error: `Drawing ${d.id} already exists.` };
        if (cmd.actor === 'ai' && (d.layer !== 'ai' || d.origin.by !== 'ai')) return { ok: false, error: 'AI drawings must be on the AI layer.' };
        remember(d.id);
        scratch.set(d.id, d);
      } else {
        const cur = scratch.get(op.id);
        if (!cur) return { ok: false, error: `Drawing ${op.id} not found.` };
        if (cmd.actor === 'ai' && cur.locked) return { ok: false, error: `Drawing ${op.id} is locked; the AI may not change it.` };
        remember(op.id);
        if (op.op === 'delete') { scratch.delete(op.id); continue; }
        const keys = Object.keys(op.patch);
        const bad = keys.find((k) => PROTECTED.has(k));
        if (bad) return { ok: false, error: `Field '${bad}' cannot be changed.` };
        if (cmd.actor === 'ai' && 'locked' in op.patch) return { ok: false, error: 'The AI may not lock or unlock drawings.' };
        const patch = { ...op.patch } as Record<string, unknown>;
        if (patch.style && typeof patch.style === 'object') patch.style = { ...cur.style, ...(patch.style as object) };
        const merged = DrawingSchema.safeParse({ ...cur, ...patch });
        if (!merged.success) return { ok: false, error: `Invalid change: ${merged.error.issues[0]?.message ?? 'schema'}` };
        scratch.set(op.id, merged.data);
      }
    }
    const changes: Change[] = [];
    for (const [id, before] of first) {
      const after = scratch.get(id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ id, before, after });
    }
    return { ok: true, changes };
  }

  private apply(changes: Change[], side: 'before' | 'after') {
    for (const c of changes) {
      const target = c[side];
      if (target) this.items.set(c.id, target);
      else this.items.delete(c.id);
    }
  }

  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.apply(entry.changes, 'before');
    this.redoStack.push(entry);
    this.emit({ type: 'changes', entry, direction: 'undo' });
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.apply(entry.changes, 'after');
    this.undoStack.push(entry);
    this.emit({ type: 'changes', entry, direction: 'redo' });
    return entry;
  }

  /** Undo every change by `actor` since `since` (e.g. "undo all AI changes today"), newest first. */
  revertActor(actor: Actor, since: number): number {
    let n = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const e = this.undoStack[i]!;
      if (e.actor !== actor || e.at < since) continue;
      this.undoStack.splice(i, 1);
      this.apply(e.changes, 'before');
      this.emit({ type: 'changes', entry: e, direction: 'undo' });
      n++;
    }
    if (n) this.redoStack = [];
    return n;
  }
}
