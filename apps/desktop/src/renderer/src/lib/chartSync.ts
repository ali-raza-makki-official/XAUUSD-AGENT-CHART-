/**
 * Links the chart panes. Panes can have different timeframes, so everything is exchanged by TIME (and price), never by
 * bar index; each pane converts to its own bars. The crosshair is always linked; scrolling only when `scroll` is on.
 */
export interface SyncMember {
  /** Show the other pane's crosshair here (null clears it). */
  crosshair(time: number | null, price: number | null): void;
  /** Show the same visible time window (unix seconds, broker clock). */
  range(fromTime: number, toTime: number): void;
}

export class ChartSync {
  scroll = false;
  private members = new Map<number, SyncMember>();

  register(id: number, m: SyncMember): () => void {
    this.members.set(id, m);
    return () => { this.members.delete(id); };
  }

  crosshair(from: number, time: number | null, price: number | null): void {
    for (const [id, m] of this.members) if (id !== from) m.crosshair(time, price);
  }

  range(from: number, fromTime: number, toTime: number): void {
    if (!this.scroll) return;
    for (const [id, m] of this.members) if (id !== from) m.range(fromTime, toTime);
  }
}
