import { EventEmitter } from 'node:events';
import {
  AlertMonitor, AlertStore, DesktopChannel, NotificationLog, NotificationRegistry, NotificationRouter, barStart, describeCondition, referenceIssue,
  type Alert, type AlertCommand, type AlertDispatchResult, type AlertsSnapshot, type AlertView, type AppConfig, type Candle, type Drawing,
  type FeedStatus, type FireRecord, type NotificationEvent, type NotificationLogEntry, type Tick, type Timeframe, type AlertActor, type AlertState,
} from '@aurum/core';

/** What the service needs from the bridge. BridgeManager satisfies it; tests pass a fake. */
export interface AlertFeed {
  on(ev: 'tick', fn: (t: Tick) => void): unknown;
  on(ev: 'status', fn: (s: FeedStatus) => void): unknown;
  readonly status: FeedStatus;
  readonly lastTick: Tick | null;
  candles(tf: Timeframe, count: number): Promise<Candle[]>;
}

/** The SQLite helpers from db.ts, injected so this file has no Electron dependency. */
export interface AlertDb {
  loadAlertData(): { alerts: Alert[]; states: Record<string, unknown>; fires: FireRecord[]; notifications: NotificationLogEntry[]; commandIds: string[] };
  persistAlertChange(p: { log: { commandId: string; actor: AlertActor; kind: 'do' | 'undo' | 'redo'; label: string }; changes: { id: string; after: Alert | null }[] }): void;
  saveAlertState(alertId: string, state: unknown): void;
  saveAlertFire(f: FireRecord): void;
  saveNotification(e: NotificationLogEntry): void;
  loadDrawings(symbol: string): { drawings: Drawing[] };
}

export interface AlertServiceDeps {
  feed: AlertFeed;
  db: AlertDb;
  getConfig: () => Pick<AppConfig, 'symbol' | 'notifications'>;
  /** Shows the OS notification. Throws when the system cannot (that is logged as a failed delivery). */
  show: (event: NotificationEvent, opts: { silent: boolean }) => void;
  now?: () => number;
  newId?: () => string;
}

const CANDLE_RETRY_MS = 5_000;

/**
 * Runs the alert engine in the main process, so alerts keep working with the window hidden. Feeds it bridge ticks/status,
 * a 1 s clock, closed candles (fetched only when a new bar appears) and the drawings read from SQLite.
 */
export class AlertService extends EventEmitter<{ changed: [AlertsSnapshot]; fired: [FireRecord] }> {
  readonly registry = new NotificationRegistry();
  readonly log = new NotificationLog();
  readonly router: NotificationRouter;
  readonly store: AlertStore;
  readonly monitor: AlertMonitor;
  /** Last persistence error, if SQLite refused a write. Surfaced instead of swallowed. */
  lastError: string | null = null;

  private drawings: Drawing[] = [];
  private candles: Partial<Record<Timeframe, Candle[]>> = {};
  private candleBar: Partial<Record<Timeframe, number>> = {};
  private candleTry: Partial<Record<Timeframe, number>> = {};
  private fetching = new Set<Timeframe>();
  private timer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly d: AlertServiceDeps) {
    super();
    this.now = d.now ?? Date.now;
    this.newId = d.newId ?? (() => globalThis.crypto.randomUUID());
    this.router = new NotificationRouter(this.registry, this.log, this.now);
    this.store = new AlertStore({
      now: this.now,
      checkReferences: (c) => { this.refreshDrawings(); return referenceIssue(c, this.drawings); },
    });
    this.monitor = new AlertMonitor({
      store: this.store, router: this.router, now: this.now, newId: this.newId, symbol: () => d.getConfig().symbol,
      persistence: {
        saveState: (id: string, s: AlertState) => this.guard(() => d.db.saveAlertState(id, s)),
        saveFire: (f: FireRecord) => this.guard(() => d.db.saveAlertFire(f)),
      },
    });
    this.registry.register(new DesktopChannel(d.show, () => d.getConfig().notifications, this.now));
  }

  private guard(fn: () => void): void {
    try { fn(); } catch (e) { this.lastError = e instanceof Error ? e.message : String(e); console.error('[alerts] persistence failed:', this.lastError); }
  }

  /** Load persisted alerts/state/history, subscribe to the feed and start the 1 s clock. */
  start(): void {
    const data = this.d.db.loadAlertData();
    this.store.load(data.alerts, data.commandIds);
    this.monitor.loadStates(data.states);
    this.monitor.loadFires(data.fires);
    this.log.load(data.notifications);
    this.refreshDrawings();

    this.store.subscribe((e) => {
      if (e.type !== 'changes') return;
      const side = e.direction === 'undo' ? 'before' : 'after';
      this.guard(() => this.d.db.persistAlertChange({
        log: { commandId: e.entry.commandId, actor: e.entry.actor, kind: e.direction, label: e.entry.label },
        changes: e.entry.changes.map((c) => ({ id: c.id, after: c[side] })),
      }));
    });
    this.log.subscribe((entry) => { this.guard(() => this.d.db.saveNotification(entry)); this.pushSoon(); });
    this.monitor.subscribe(() => this.pushSoon());
    this.d.feed.on('tick', () => this.evaluate());
    this.d.feed.on('status', () => this.evaluate());
    this.timer = setInterval(() => this.evaluate(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.timer = this.pushTimer = null;
  }

  /** Re-read the current symbol's drawings from SQLite. Called whenever the renderer persists drawings. */
  refreshDrawings(): void {
    try { this.drawings = this.d.db.loadDrawings(this.d.getConfig().symbol).drawings; } catch (e) { this.lastError = e instanceof Error ? e.message : String(e); }
  }

  /** Run one evaluation pass now (tick, status change, timer, or right after an alert changed). */
  evaluate(): void {
    const tick = this.d.feed.lastTick;
    this.ensureCandles(tick);
    const fires = this.monitor.evaluate({
      tick, lastClosedCandlesByTf: this.candles, drawings: this.drawings, now: this.now(), feedStatus: this.d.feed.status,
    });
    for (const f of fires) if (f.kind === 'fired') this.emit('fired', f);
  }

  /** Timeframes used by alerts that can still fire. */
  private neededTimeframes(): Set<Timeframe> {
    const out = new Set<Timeframe>();
    for (const v of this.monitor.view()) {
      const c = v.alert.condition;
      if (c.type === 'candle_close' && v.alert.enabled && v.status !== 'done' && v.status !== 'expired') out.add(c.timeframe);
    }
    return out;
  }

  private ensureCandles(tick: Tick | null): void {
    if (!tick) return;
    for (const tf of this.neededTimeframes()) {
      const bar = barStart(tick.time, tf);
      if (this.candleBar[tf] === bar || this.fetching.has(tf)) continue;
      if (this.now() - (this.candleTry[tf] ?? 0) < CANDLE_RETRY_MS) continue;
      this.candleTry[tf] = this.now();
      this.fetching.add(tf);
      this.d.feed.candles(tf, 5)
        .then((c) => { this.candles[tf] = c; this.candleBar[tf] = bar; this.evaluate(); })
        .catch(() => undefined) // the alert shows "waiting"; retried after CANDLE_RETRY_MS
        .finally(() => this.fetching.delete(tf));
    }
  }

  // ---------- API for IPC, the AI port and other services (WhatsApp) ----------

  snapshot(limit = 100): AlertsSnapshot { return this.monitor.snapshot(limit); }
  listView(): AlertView[] { return this.monitor.view(); }

  dispatch(cmd: AlertCommand): AlertDispatchResult {
    const r = this.store.dispatch(cmd);
    if (r.ok) this.evaluate();
    return r;
  }
  undo(): boolean { const e = this.store.undo(); if (e) this.evaluate(); return !!e; }
  redo(): boolean { const e = this.store.redo(); if (e) this.evaluate(); return !!e; }

  /** Sends a clearly labelled test notification through the real channels. It is not a fire: no state, no fire history. */
  async testFire(id: string): Promise<{ ok: boolean; error?: string }> {
    const alert = this.store.get(id);
    if (!alert) return { ok: false, error: 'Alert not found.' };
    const at = this.now();
    const event: NotificationEvent = {
      id: this.newId(), alertId: alert.id, title: `[Test] ${alert.name}`, body: `Test notification for: ${describeCondition(alert.condition)}`,
      severity: alert.severity, at,
      data: { alertName: alert.name, reason: 'Test notification', values: {}, condition: describeCondition(alert.condition), channels: alert.channels, origin: 'manual', test: true },
    };
    await this.router.dispatch(event);
    this.emit('fired', { id: event.id, alertId: alert.id, alertName: `[Test] ${alert.name}`, at, kind: 'fired', reason: 'Test notification', values: { test: true }, message: event.body, severity: alert.severity, notificationId: event.id });
    return { ok: true };
  }

  private pushSoon(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; this.emit('changed', this.snapshot()); }, 100);
  }
}
