import type { DatabaseSync } from 'node:sqlite';
import type { PaperTick } from '@aurum/core';

/**
 * Every price tick, kept locally in a compact table (about 24 bytes a row). Repeated identical quotes are skipped, writes are
 * batched, and rows older than the retention period are deleted. Paper results and notes outlive the ticks.
 */
export class TickStore {
  private buf: PaperTick[] = [];
  private last: { bid: number; ask: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: () => DatabaseSync, private readonly flushMs = 2000) {}

  start(): void { if (!this.timer) this.timer = setInterval(() => this.flush(), this.flushMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.flush(); }

  /** Returns true when the tick carried new information and was queued. */
  record(ts: number, bid: number, ask: number): boolean {
    if (!(bid > 0) || !(ask >= bid)) return false;
    if (this.last && this.last.bid === bid && this.last.ask === ask) return false;
    this.last = { bid, ask };
    this.buf.push({ ts, bid, ask });
    if (this.buf.length >= 500) this.flush();
    return true;
  }

  flush(): void {
    if (!this.buf.length) return;
    const rows = this.buf; this.buf = [];
    const db = this.db();
    try {
      const ins = db.prepare('INSERT INTO ticks (ts, bid, ask) VALUES (?, ?, ?)');
      db.exec('BEGIN');
      for (const r of rows) ins.run(r.ts, r.bid, r.ask);
      db.exec('COMMIT');
    } catch { try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ } }
  }

  /** Ticks in [from, to] oldest first. Includes ticks still waiting in memory. */
  range(from: number, to: number, limit = 2_000_000): PaperTick[] {
    this.flush();
    return this.db().prepare('SELECT ts, bid, ask FROM ticks WHERE ts >= ? AND ts <= ? ORDER BY ts LIMIT ?').all(from, to, limit) as unknown as PaperTick[];
  }

  stats(): { count: number; first: number | null; last: number | null; approxBytes: number } {
    this.flush();
    const r = this.db().prepare('SELECT COUNT(*) AS n, MIN(ts) AS a, MAX(ts) AS b FROM ticks').get() as { n: number; a: number | null; b: number | null };
    return { count: r.n, first: r.a, last: r.b, approxBytes: r.n * 24 };
  }

  purge(olderThanMs: number): number {
    this.flush();
    return Number(this.db().prepare('DELETE FROM ticks WHERE ts < ?').run(olderThanMs).changes);
  }
}
