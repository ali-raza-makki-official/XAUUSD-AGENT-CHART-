import {
  AlertStateSchema, describeCondition, describeRepeat, eventOccurrences, evaluateAlert, forgetSamples, renderMessage,
  type Alert, type AlertSnapshot, type AlertState, type EvalStatus, type EvalValues, type Severity,
} from './alerts';
import type { AlertStore } from './alertStore';
import type { NotificationEvent, NotificationLogEntry, NotificationRouter } from './notifications';

/** One alert firing (or, for time events, being missed while the app was closed). Missed ones never notify. */
export interface FireRecord {
  id: string;
  alertId: string;
  alertName: string;
  at: number;
  kind: 'fired' | 'missed';
  reason: string;
  values: EvalValues;
  /** Rendered message body. */
  message: string;
  severity: Severity;
  notificationId: string | null;
}

export interface AlertView {
  alert: Alert;
  summary: string;
  repeatLabel: string;
  status: EvalStatus | 'pending' | 'armed';
  statusDetail: string;
  fireCount: number;
  lastFiredAt: number | null;
  /** ISO time of the next scheduled/session event, when the condition is time based. */
  nextAt: string | null;
}

export interface AlertsSnapshot {
  alerts: AlertView[];
  fires: FireRecord[];
  notifications: NotificationLogEntry[];
  canUndo: boolean;
  canRedo: boolean;
}

/** Persistence hooks. The desktop app writes these to SQLite; tests can leave them out or record calls. */
export interface MonitorPersistence {
  saveState(alertId: string, state: AlertState): void;
  saveFire(fire: FireRecord): void;
}

export interface MonitorOptions {
  store: AlertStore;
  router: NotificationRouter;
  persistence?: MonitorPersistence;
  now?: () => number;
  newId?: () => string;
  symbol?: () => string;
}

const MAX_FIRES = 300;

/**
 * Runs the pure engine for every alert whenever the host feeds it a snapshot (live tick, feed status change, timer).
 * It owns the per-alert runtime state, turns fires into NotificationEvents and hands them to the router.
 * There is no LLM call anywhere in this path.
 */
export class AlertMonitor {
  private states = new Map<string, AlertState>();
  private outcomes = new Map<string, { status: EvalStatus; reason: string }>();
  private fires: FireRecord[] = [];
  private pending: Promise<unknown>[] = [];
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: MonitorOptions) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => globalThis.crypto.randomUUID());
    o.store.subscribe(() => this.notify());
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { this.listeners.forEach((l) => l()); }

  /** Restore persisted runtime state at startup. Price memory is forgotten (first sample rule); fired/progress flags are kept. */
  loadStates(states: Record<string, unknown>): void {
    this.states.clear();
    for (const [id, raw] of Object.entries(states)) {
      const p = AlertStateSchema.safeParse(raw);
      if (p.success) this.states.set(id, forgetSamples(p.data));
    }
  }
  loadFires(fires: FireRecord[]): void { this.fires = fires.slice(-MAX_FIRES); }
  stateOf(id: string): AlertState | undefined { return this.states.get(id); }

  /** Resolves once every notification dispatched so far has been delivered (or failed). */
  async flush(): Promise<void> { await Promise.all(this.pending); this.pending = []; }

  evaluate(snap: AlertSnapshot): FireRecord[] {
    const out: FireRecord[] = [];
    let changed = false;
    for (const alert of this.o.store.list()) {
      let outcome;
      try {
        outcome = evaluateAlert(alert, snap, this.states.get(alert.id));
      } catch (e) {
        this.outcomes.set(alert.id, { status: 'invalid', reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const prevState = this.states.get(alert.id);
      if (JSON.stringify(prevState) !== JSON.stringify(outcome.state)) {
        this.states.set(alert.id, outcome.state);
        this.o.persistence?.saveState(alert.id, outcome.state);
      }
      const before = this.outcomes.get(alert.id)?.status;
      this.outcomes.set(alert.id, { status: outcome.status, reason: outcome.reason });
      if (before !== outcome.status) changed = true;

      if (outcome.fire || outcome.status === 'missed') {
        const rec = outcome.fire ? this.record(alert, outcome.reason, outcome.values, snap.now) : this.recordMissed(alert, outcome.reason, outcome.values, snap.now);
        out.push(rec);
        changed = true;
      }
    }
    if (changed) this.notify();
    return out;
  }

  private record(alert: Alert, reason: string, values: EvalValues, at: number): FireRecord {
    const price = typeof values.price === 'number' ? values.price : typeof values.close === 'number' ? values.close : null;
    const level = typeof values.level === 'number' ? values.level : null;
    const message = renderMessage(alert.message.trim() || '{reason}', {
      name: alert.name, reason, price: price === null ? null : price.toFixed(2), level: level === null ? null : level.toFixed(2),
      time: new Date(at).toISOString(), symbol: this.o.symbol?.() ?? 'XAUUSD',
    });
    const event: NotificationEvent = {
      id: this.newId(), alertId: alert.id, title: alert.name, body: message, severity: alert.severity, at,
      data: { alertName: alert.name, reason, values, condition: describeCondition(alert.condition), channels: alert.channels, origin: alert.origin.by },
    };
    const rec: FireRecord = { id: this.newId(), alertId: alert.id, alertName: alert.name, at, kind: 'fired', reason, values, message, severity: alert.severity, notificationId: event.id };
    this.push(rec);
    this.pending.push(this.o.router.dispatch(event));
    return rec;
  }

  private recordMissed(alert: Alert, reason: string, values: EvalValues, at: number): FireRecord {
    const rec: FireRecord = { id: this.newId(), alertId: alert.id, alertName: alert.name, at, kind: 'missed', reason, values, message: reason, severity: alert.severity, notificationId: null };
    this.push(rec);
    return rec;
  }

  private push(rec: FireRecord) {
    this.fires.push(rec);
    if (this.fires.length > MAX_FIRES) this.fires.splice(0, this.fires.length - MAX_FIRES);
    this.o.persistence?.saveFire(rec);
  }

  recentFires(limit = 50): FireRecord[] { return this.fires.slice(-limit).reverse(); }

  view(): AlertView[] {
    const now = this.now();
    return this.o.store.list().map((alert) => {
      const st = this.states.get(alert.id);
      const out = this.outcomes.get(alert.id);
      const c = alert.condition;
      const next = c.type === 'session' || c.type === 'schedule' ? eventOccurrences(c, now).next : null;
      const status: AlertView['status'] = !alert.enabled ? 'disabled' : st?.done ? 'done'
        : alert.expiresAt !== null && now >= alert.expiresAt ? 'expired' : out ? (out.status === 'ok' ? 'armed' : out.status) : 'pending';
      return {
        alert, summary: describeCondition(c), repeatLabel: describeRepeat(alert.repeat), status,
        statusDetail: !alert.enabled ? 'Disabled.' : st?.done ? 'Already fired. Re-arm to use it again.' : out?.reason ?? 'Waiting for the first market sample.',
        fireCount: st?.fireCount ?? 0, lastFiredAt: st?.lastFiredAt ?? null, nextAt: next === null ? null : new Date(next).toISOString(),
      };
    });
  }

  snapshot(limit = 100): AlertsSnapshot {
    return {
      alerts: this.view(), fires: this.recentFires(limit), notifications: this.o.router.log.recent(limit),
      canUndo: this.o.store.canUndo, canRedo: this.o.store.canRedo,
    };
  }
}
