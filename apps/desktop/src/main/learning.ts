import { buildPath, findings, suggestTuning, type AppConfig, type Finding, type PaperTrade, type Tuning, type TunePath } from '@aurum/core';
import type { PaperService } from './paper';
import type { TickStore } from './ticks';

export interface TuneLogEntry { at: number; auto: boolean; from: { slPips: number; tpPips: number }; to: { slPips: number; tpPips: number }; evidence: string }
export interface Insights {
  finished: number; open: number; findings: Finding[]; tuning: Tuning | null; log: TuneLogEntry[];
  ticks: { count: number; first: number | null; last: number | null; approxBytes: number };
}

/**
 * Turns paper results and recorded ticks into findings and (with enough evidence) a suggested default stop/target pair.
 * It never touches risk limits, and a change to the defaults is logged and can be undone with one click.
 */
export class LearningService {
  private cache: { at: number; value: Insights } | null = null;
  constructor(private readonly d: {
    getConfig(): AppConfig; paper: PaperService; ticks: TickStore;
    kv: { get(k: string): string | null; set(k: string, v: string): void };
    setDefaults(sl: number, tp: number): void; notify(text: string): void; now?: () => number;
  }) {}
  private now() { return this.d.now?.() ?? Date.now(); }

  private log(): TuneLogEntry[] { try { return JSON.parse(this.d.kv.get('tune_log') ?? '[]') as TuneLogEntry[]; } catch { return []; } }

  private paths(trades: PaperTrade[]): TunePath[] {
    const cfg = this.d.getConfig();
    const out: TunePath[] = [];
    for (const t of trades.slice(0, 300)) {
      if (t.openedAt === undefined || t.openPrice === undefined) continue;
      const ticks = this.d.ticks.range(t.openedAt, t.openedAt + t.maxHoldMs, 400_000);
      if (ticks.length < 2) continue; // the ticks were not recorded (or have been purged): this trade cannot be replayed
      const path = buildPath(t.side, t.openPrice, ticks, cfg.pipSize);
      const last = ticks[ticks.length - 1]!;
      const lastPips = ((t.side === 'buy' ? last.bid - t.openPrice : t.openPrice - last.ask) / cfg.pipSize);
      out.push({ path, lastPips, openedAt: t.openedAt });
    }
    return out;
  }

  insights(force = false): Insights {
    if (!force && this.cache && this.now() - this.cache.at < 30_000) return this.cache.value;
    const all = this.d.paper.list();
    const done = all.filter((t) => t.status === 'won' || t.status === 'lost' || t.status === 'timeout');
    const cur = this.d.getConfig().assistant.defaults;
    const tuning = suggestTuning(this.paths(done), { slPips: cur.slPips, tpPips: cur.tpPips });
    const value: Insights = { finished: done.length, open: all.filter((t) => t.status === 'open' || t.status === 'pending').length, findings: findings(done), tuning, log: this.log().slice(-20).reverse(), ticks: this.d.ticks.stats() };
    this.cache = { at: this.now(), value };
    return value;
  }

  apply(slPips: number, tpPips: number, auto: boolean, evidence: string): void {
    const cur = this.d.getConfig().assistant.defaults;
    if (cur.slPips === slPips && cur.tpPips === tpPips) return;
    const entry: TuneLogEntry = { at: this.now(), auto, from: { slPips: cur.slPips, tpPips: cur.tpPips }, to: { slPips, tpPips }, evidence };
    this.d.kv.set('tune_log', JSON.stringify([...this.log(), entry].slice(-50)));
    this.d.setDefaults(slPips, tpPips);
    this.cache = null;
    if (auto) this.d.notify(`Learning: new plans now default to a ${slPips}-pip stop and ${tpPips}-pip target (was ${cur.slPips}/${cur.tpPips}). ${evidence}`);
  }

  /** Undo the most recent change of the defaults. */
  revert(): boolean {
    const log = this.log();
    const last = log.pop();
    if (!last) return false;
    this.d.kv.set('tune_log', JSON.stringify(log));
    this.d.setDefaults(last.from.slPips, last.from.tpPips);
    this.cache = null;
    return true;
  }

  /** Called now and then: applies a recommendation by itself only when the setting allows it AND the evidence is confident. */
  maybeAutoTune(): void {
    if (!this.d.getConfig().learning.autoTune) return;
    const t = this.insights(true).tuning;
    if (t?.confident) this.apply(t.best.slPips, t.best.tpPips, true, t.reason);
  }
}
