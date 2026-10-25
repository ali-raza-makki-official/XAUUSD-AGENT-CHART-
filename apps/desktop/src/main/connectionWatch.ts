import type { FeedStatus } from '@aurum/core';

/**
 * Turns feed status changes into at most one "MT5 lost" and one "MT5 back" message per outage.
 * Nothing is said before the first successful connection (a PC that boots before MT5 is not an outage) and a drop
 * that heals within the grace period is ignored. "Stale" (market closed / quiet) is not a disconnect.
 */
export interface WatchDeps {
  notify(text: string, priority: 'critical' | 'normal'): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  graceMs?: number;
}

export class ConnectionWatcher {
  private everUp = false;
  private downSince: number | null = null;
  private announced = false;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly set: (fn: () => void, ms: number) => unknown;
  private readonly clear: (h: unknown) => void;
  private readonly grace: number;

  constructor(private readonly d: WatchDeps) {
    this.now = d.now ?? Date.now;
    this.set = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clear = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.grace = d.graceMs ?? 20_000;
  }

  onStatus(s: FeedStatus): void {
    if (s.state === 'connected' || s.state === 'stale') {
      this.everUp = true;
      if (this.timer !== null) { this.clear(this.timer); this.timer = null; }
      if (this.announced && this.downSince !== null) {
        const mins = Math.max(1, Math.round((this.now() - this.downSince) / 60_000));
        this.d.notify(`MT5 is connected again (it was away about ${mins} min). Aurum is working normally.`, 'normal');
      }
      this.downSince = null; this.announced = false;
      return;
    }
    if (s.state === 'starting' || !this.everUp || this.downSince !== null) return;
    this.downSince = this.now();
    this.timer = this.set(() => {
      this.timer = null;
      this.announced = true;
      this.d.notify('MT5 connection lost. Aurum keeps trying and will reconnect by itself when the MT5 terminal and the AurumBridge EA are running.', 'critical');
    }, this.grace);
  }

  dispose(): void { if (this.timer !== null) this.clear(this.timer); this.timer = null; }
}
