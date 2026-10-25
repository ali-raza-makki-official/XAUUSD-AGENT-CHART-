import type { DatabaseSync } from 'node:sqlite';
import { PaperTradeSchema, isActive, paperStep, sessionOfHour, type AppConfig, type PaperTick, type PaperTrade, type TradePlan } from '@aurum/core';

const WORKSPACE = 'default';

export interface PaperStore { list(): PaperTrade[]; save(t: PaperTrade): void }

export class SqlitePaperStore implements PaperStore {
  constructor(private readonly db: () => DatabaseSync) {}
  list(): PaperTrade[] {
    const rows = this.db().prepare('SELECT json FROM paper_trades WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 5000').all(WORKSPACE) as { json: string }[];
    return rows.flatMap((r) => { const p = PaperTradeSchema.safeParse(JSON.parse(r.json)); return p.success ? [p.data] : []; });
  }
  save(t: PaperTrade): void {
    this.db().prepare('INSERT INTO paper_trades (id, workspace_id, json, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id, workspace_id) DO UPDATE SET json = excluded.json, status = excluded.status, updated_at = excluded.updated_at')
      .run(t.id, WORKSPACE, JSON.stringify(t), t.status, Date.now());
  }
}

/**
 * Judges every idea on the real recorded ticks, whether or not it was ever traded live: plans (approved or not), AI analyses with a
 * trade idea, and the user's own ideas. Nothing here sends orders.
 */
export class PaperService {
  private active = new Map<string, PaperTrade>();
  private dirty = new Set<string>();
  private lastFlush = 0;
  private readonly now: () => number;

  constructor(private readonly d: { getConfig(): AppConfig; store: PaperStore; changed(): void; now?: () => number }) {
    this.now = d.now ?? Date.now;
    for (const t of d.store.list()) if (isActive(t)) this.active.set(t.id, t);
  }

  list(): PaperTrade[] {
    const saved = new Map(this.d.store.list().map((t) => [t.id, t]));
    for (const [id, t] of this.active) saved.set(id, t); // newest in-memory state wins
    return [...saved.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  get(id: string): PaperTrade | null { return this.active.get(id) ?? this.d.store.list().find((t) => t.id === id) ?? null; }

  private put(t: PaperTrade, persistNow = true): PaperTrade {
    if (isActive(t)) this.active.set(t.id, t); else this.active.delete(t.id);
    if (persistNow) { this.d.store.save(t); this.dirty.delete(t.id); this.d.changed(); } else this.dirty.add(t.id);
    return t;
  }

  /** The same idea (side and zone within a pip) still waiting or open from the last 6 hours, if any: repeated analyses must not pile up copies. */
  similar(side: 'buy' | 'sell', zone: { low: number; high: number }, source: PaperTrade['source']): PaperTrade | null {
    const pip = this.d.getConfig().pipSize, now = this.now();
    return this.list().find((t) => t.source === source && t.side === side && t.zone && Math.abs(t.zone.low - zone.low) <= pip && Math.abs(t.zone.high - zone.high) <= pip && now - t.createdAt < 6 * 3600_000) ?? null;
  }

  /** Record an idea. Ids are stable, so recording the same idea twice keeps the first. */
  create(input: Omit<Partial<PaperTrade>, 'id' | 'status' | 'createdAt'> & Pick<PaperTrade, 'id' | 'source' | 'side' | 'entry' | 'slPips' | 'tpPips'>): PaperTrade {
    const existing = this.get(input.id);
    if (existing) return existing;
    const cfg = this.d.getConfig().learning;
    const now = this.now();
    const hour = new Date(now).getUTCHours();
    const t = PaperTradeSchema.parse({
      expiresAt: now + 24 * 3600_000, maxHoldMs: cfg.paperMaxHoldHours * 3600_000, ...input, createdAt: now, status: 'pending',
      tags: { session: sessionOfHour(hour), hourUtc: hour, ...(input.tags ?? {}) },
    });
    return this.put(t);
  }

  /** A trade plan gets a shadow paper trade the moment it exists; it is marked "also placed live" once a real order exists. */
  syncPlan(plan: TradePlan): void {
    const id = `paper-${plan.id}`;
    let t = this.get(id);
    if (!t) {
      t = this.create({
        id, source: 'plan', sourceId: plan.id, side: plan.side, entry: plan.entry, zone: plan.zone, slPips: plan.slPips, tpPips: plan.tpPips,
        expiresAt: plan.expiresAt, note: plan.note,
        tags: { createdBy: plan.createdBy, autoTake: plan.autoTake, riskPct: plan.riskPct, zonePips: Math.round(((plan.zone.high - plan.zone.low) / this.d.getConfig().pipSize) * 10) / 10 },
      });
    }
    if (plan.status === 'filled' && !t.live) this.put({ ...t, live: true });
  }

  /** Advance every active paper trade by one real tick. Cheap when nothing is active. */
  onTick(tick: PaperTick): void {
    if (!this.active.size) return;
    const pip = this.d.getConfig().pipSize;
    for (const t of [...this.active.values()]) {
      const next = paperStep(t, tick, pip);
      if (next === t) continue;
      const finishedNow = !isActive(next) || next.status !== t.status;
      this.put(next, finishedNow);
    }
    const now = this.now();
    if (this.dirty.size && now - this.lastFlush > 5000) {
      this.lastFlush = now;
      for (const id of [...this.dirty]) { const t = this.active.get(id); if (t) this.d.store.save(t); this.dirty.delete(id); }
    }
  }
}
