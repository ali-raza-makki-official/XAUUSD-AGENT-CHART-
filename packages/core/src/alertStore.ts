import { z } from 'zod';
import {
  AlertActorSchema, AlertConditionSchema, AlertSchema, ChannelsSchema, RepeatSchema, SeveritySchema, eventOccurrences,
  type Alert, type AlertActor, type AlertCondition,
} from './alerts';

/**
 * Single source of truth for alert definitions, same pattern as DrawingStore: every change is a command with a unique
 * commandId (idempotent), an actor, validation, undo/redo and an activity-log entry. The manual UI, the AI tools and
 * (later) WhatsApp all call dispatch(). Fires are system events handled by the AlertMonitor, not commands.
 */

export const MAX_ALERTS = 200;
export const MAX_AI_ALERTS = 50;

export const AlertPatchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  condition: AlertConditionSchema,
  repeat: RepeatSchema,
  expiresAt: z.number().int().nullable(),
  channels: ChannelsSchema,
  message: z.string().max(500),
  severity: SeveritySchema,
  /** Clear the "already fired" state and start fresh from the next sample. */
  rearm: z.boolean(),
}).partial().strict();
export type AlertPatch = z.infer<typeof AlertPatchSchema>;

export const AlertOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), alert: AlertSchema }),
  z.object({ op: z.literal('update'), id: z.string().min(1), patch: AlertPatchSchema }),
  z.object({ op: z.literal('delete'), id: z.string().min(1) }),
]);
export type AlertOp = z.infer<typeof AlertOpSchema>;

export const AlertCommandSchema = z.object({
  commandId: z.string().min(8),
  actor: AlertActorSchema,
  label: z.string().max(200),
  ops: z.array(AlertOpSchema).min(1).max(20),
});
export type AlertCommand = z.infer<typeof AlertCommandSchema>;

export interface AlertChange { id: string; before: Alert | null; after: Alert | null }
export interface AlertHistoryEntry { commandId: string; actor: AlertActor; label: string; at: number; changes: AlertChange[] }
export type AlertDispatchResult =
  | { ok: true; duplicate: boolean; entry: AlertHistoryEntry | null }
  | { ok: false; error: string };
export type AlertStoreEvent =
  | { type: 'changes'; entry: AlertHistoryEntry; direction: 'do' | 'undo' | 'redo' }
  | { type: 'loaded' };

export interface AlertStoreOptions {
  now?: () => number;
  /** Extra validation against the outside world, e.g. that a referenced drawing exists. Return an error sentence or null. */
  checkReferences?: (condition: AlertCondition) => string | null;
}

export class AlertStore {
  private items = new Map<string, Alert>();
  private undoStack: AlertHistoryEntry[] = [];
  private redoStack: AlertHistoryEntry[] = [];
  private seen = new Set<string>();
  private listeners = new Set<(e: AlertStoreEvent) => void>();
  private readonly now: () => number;
  private readonly checkReferences?: (c: AlertCondition) => string | null;

  constructor(opts: AlertStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.checkReferences = opts.checkReferences;
  }

  list(): Alert[] { return [...this.items.values()]; }
  get(id: string): Alert | undefined { return this.items.get(id); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  history(): readonly AlertHistoryEntry[] { return this.undoStack; }

  subscribe(fn: (e: AlertStoreEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: AlertStoreEvent) { this.listeners.forEach((l) => l(e)); }

  /** Replace everything (startup load). Undo history starts empty. */
  load(alerts: Alert[], seenCommandIds: Iterable<string> = []): void {
    this.items = new Map(alerts.map((a) => [a.id, a]));
    this.undoStack = [];
    this.redoStack = [];
    this.seen = new Set(seenCommandIds);
    this.emit({ type: 'loaded' });
  }

  dispatch(raw: AlertCommand): AlertDispatchResult {
    const parsedCmd = AlertCommandSchema.safeParse(raw);
    if (!parsedCmd.success) return { ok: false, error: `Invalid command: ${parsedCmd.error.issues[0]?.message ?? 'schema'}` };
    const cmd = parsedCmd.data;
    if (this.seen.has(cmd.commandId)) return { ok: true, duplicate: true, entry: null };
    const planned = this.plan(cmd);
    if (!planned.ok) return planned;
    if (planned.changes.length === 0) return { ok: true, duplicate: false, entry: null };
    const entry: AlertHistoryEntry = { commandId: cmd.commandId, actor: cmd.actor, label: cmd.label, at: this.now(), changes: planned.changes };
    this.apply(entry.changes, 'after');
    this.seen.add(cmd.commandId);
    this.undoStack.push(entry);
    this.redoStack = [];
    this.emit({ type: 'changes', entry, direction: 'do' });
    return { ok: true, duplicate: false, entry };
  }

  /** Validate every op on a scratch copy first, so a batch is all-or-nothing. */
  private plan(cmd: AlertCommand): { ok: true; changes: AlertChange[] } | { ok: false; error: string } {
    const now = this.now();
    const scratch = new Map(this.items);
    const first = new Map<string, Alert | null>();
    const remember = (id: string) => { if (!first.has(id)) first.set(id, this.items.get(id) ?? null); };
    const timeIssue = (c: AlertCondition, expiresAt: number | null): string | null => {
      if (c.type === 'schedule' && c.when.kind === 'once' && Date.parse(c.when.at) <= now) return 'The scheduled time is already in the past.';
      if (expiresAt !== null && expiresAt <= now) return 'The expiry time is already in the past.';
      if (c.type === 'schedule' || c.type === 'session') {
        try { eventOccurrences(c, now); } catch { return 'Invalid time settings.'; }
      }
      return null;
    };

    for (const op of cmd.ops) {
      if (op.op === 'create') {
        const a = op.alert;
        if (scratch.has(a.id)) return { ok: false, error: `Alert ${a.id} already exists.` };
        if (a.origin.by !== cmd.actor) return { ok: false, error: `Alert origin (${a.origin.by}) must match the actor (${cmd.actor}).` };
        if (scratch.size >= MAX_ALERTS) return { ok: false, error: `Too many alerts (limit ${MAX_ALERTS}). Delete some first.` };
        if (cmd.actor === 'ai' && [...scratch.values()].filter((x) => x.origin.by === 'ai').length >= MAX_AI_ALERTS) {
          return { ok: false, error: `The AI may keep at most ${MAX_AI_ALERTS} alerts. Delete old ones first.` };
        }
        const bad = this.checkReferences?.(a.condition) ?? timeIssue(a.condition, a.expiresAt);
        if (bad) return { ok: false, error: bad };
        remember(a.id);
        scratch.set(a.id, a);
        continue;
      }
      const cur = scratch.get(op.id);
      if (!cur) return { ok: false, error: `Alert ${op.id} not found.` };
      remember(op.id);
      if (op.op === 'delete') { scratch.delete(op.id); continue; }
      const { rearm, ...patch } = op.patch;
      const merged = { ...cur, ...patch };
      const rearms = rearm === true || patch.condition !== undefined || patch.repeat !== undefined || patch.expiresAt !== undefined || (patch.enabled === true && !cur.enabled);
      if (rearms) merged.armedAt = now;
      const parsed = AlertSchema.safeParse(merged);
      if (!parsed.success) return { ok: false, error: `Invalid change: ${parsed.error.issues[0]?.message ?? 'schema'}` };
      if (patch.condition !== undefined || patch.expiresAt !== undefined) {
        const bad = (patch.condition !== undefined ? this.checkReferences?.(parsed.data.condition) : null) ?? timeIssue(parsed.data.condition, parsed.data.expiresAt);
        if (bad) return { ok: false, error: bad };
      }
      scratch.set(op.id, parsed.data);
    }
    const changes: AlertChange[] = [];
    for (const [id, before] of first) {
      const after = scratch.get(id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ id, before, after });
    }
    return { ok: true, changes };
  }

  private apply(changes: AlertChange[], side: 'before' | 'after') {
    for (const c of changes) {
      const target = c[side];
      if (target) this.items.set(c.id, target);
      else this.items.delete(c.id);
    }
  }

  undo(): AlertHistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.apply(entry.changes, 'before');
    this.redoStack.push(entry);
    this.emit({ type: 'changes', entry, direction: 'undo' });
    return entry;
  }

  redo(): AlertHistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.apply(entry.changes, 'after');
    this.undoStack.push(entry);
    this.emit({ type: 'changes', entry, direction: 'redo' });
    return entry;
  }
}
