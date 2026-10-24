import type { AiPermissions, RiskSettings } from './settings';
import type { ContractSpec } from './risk';
import type { OrderState } from './command';
import { canTransition } from './command';
import {
  commandFingerprint, parseOrderCommand, previewCommand, type AnyOrderCommand, type BrokerDeal, type BrokerOrder, type BrokerOutcome, type BrokerPosition,
  type ClosePositionCommand, type Evidence, type OrderCommand, type OrderPreview,
} from './orderCommand';
import { dailyWindowStart, evaluateGate, realizedPnlSince, type GateInput, type GateResult, type GateRule } from './riskGate';

/**
 * The order engine: prepare (preview + dry gate) -> confirm (idempotent registry, fresh gate, send once) -> reconcile.
 * It talks to the broker only through `BrokerPort`, so every safety property is testable with a fake broker.
 *
 * Invariants (each has a test):
 *  - a commandId reaches the broker AT MOST ONCE, however often confirm()/retries are called, even concurrently;
 *  - an unknown result (timeout, exception, no answer) is never resent: it is reconciled through find() first;
 *  - "confirmed" is only ever set from a broker answer or from broker evidence;
 *  - the AI cannot execute in suggest mode, when the kill switch is on, or without its specific permission.
 */

export interface BrokerSnapshot {
  account: { demo: boolean; balance: number; equity?: number; currency: string; login?: number | null; server?: string } | null;
  tick: { bid: number; ask: number; time: number } | null;
  spec: (ContractSpec & { point?: number; digits?: number }) | null;
  positions: BrokerPosition[];
  orders: BrokerOrder[];
}

/** The broker/bridge refused BEFORE order_send was called (HTTP non-200). Nothing was sent. */
export class BrokerNotSent extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'BrokerNotSent'; }
}

export interface BrokerPort {
  snapshot(): Promise<BrokerSnapshot>;
  /** Deals since a broker-server-clock time (unix s). */
  deals(sinceServerSec: number): Promise<BrokerDeal[]>;
  /** Throws BrokerNotSent when nothing was sent; ANY other throw means "unknown": it may have been sent. */
  execute(action: string, body: Record<string, unknown>): Promise<BrokerOutcome>;
  find(commandId: string, ticket: number | null): Promise<Evidence>;
}

export interface EngineSettings {
  tradingEnabled: boolean;
  risk: RiskSettings;
  aiPermissions: AiPermissions;
  allowedSymbols: string[];
  pipSize: number;
}

export interface BrokerResultSummary {
  status: BrokerOutcome['status'] | 'not_sent';
  stage?: string;
  retcode?: number | null;
  retcodeName?: string;
  message?: string;
  order?: number | null;
  deal?: number | null;
  positionTicket?: number | null;
  volume?: number | null;
  price?: number | null;
  duplicate?: boolean;
}

export interface RiskSnapshot { at: number; balance: number | null; riskMoney: number | null; riskPct: number | null; slDistance: number | null; spread: number | null; bid: number | null; ask: number | null }

export interface OrderRecord {
  commandId: string;
  type: AnyOrderCommand['type'];
  actor: AnyOrderCommand['actor'];
  command: AnyOrderCommand;
  fingerprint: string;
  state: OrderState;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  preview: string;
  failedRule: GateRule | null;
  /** Plain-language reason for validation_failed / rejected / unknown_reconcile. */
  reason: string | null;
  broker: BrokerResultSummary | null;
  riskSnapshot: RiskSnapshot | null;
  /** The position/order ticket this command is about or created. */
  ticket: number | null;
  /** Position volume when a close/partial close was sent (to judge evidence later). */
  volumeBefore: number | null;
  noTraceChecks: number;
  firstNoTraceAt: number | null;
  children: string[];
  history: { at: number; state: OrderState; note: string }[];
}

export type ActivityKind = 'prepared' | 'state' | 'kill_switch' | 'reconcile' | 'resolved' | 'external_change' | 'sync';
export interface ActivityEntry { at: number; commandId: string | null; kind: ActivityKind; actor: string; state: OrderState | null; label: string; detail: Record<string, unknown> }

export type PrepareResult =
  | { ok: true; commandId: string; command: AnyOrderCommand; preview: OrderPreview; gate: GateResult; executable: boolean; account: { demo: boolean; currency: string; balance: number } | null; expiresAt: number; existing: null }
  | { ok: true; commandId: string; existing: OrderRecord }
  | { ok: false; error: string };

export interface EngineOptions {
  broker: BrokerPort;
  settings: () => EngineSettings;
  now?: () => number;
  onRecord?: (r: OrderRecord) => void;
  onActivity?: (a: ActivityEntry) => void;
  /** How long finished records stay in the idempotency registry AFTER their command expired. */
  retentionMs?: number;
  /** A "no trace in MT5" result must be seen twice at least this far apart before a command is called rejected. */
  noTraceGapMs?: number;
}

const TERMINAL: OrderState[] = ['validation_failed', 'confirmed', 'rejected'];
export const isTerminal = (s: OrderState) => TERMINAL.includes(s);
const OWN_WINDOW_MS = 20_000;

/** Idempotency registry with TTL. Records that are not terminal are never dropped. */
export class CommandRegistry {
  private readonly map = new Map<string, OrderRecord>();
  constructor(private readonly retentionMs = 24 * 3600_000) {}
  get(id: string): OrderRecord | undefined { return this.map.get(id); }
  set(r: OrderRecord): void { this.map.set(r.commandId, r); }
  all(): OrderRecord[] { return [...this.map.values()]; }
  unresolved(): OrderRecord[] { return this.all().filter((r) => r.state === 'unknown_reconcile'); }
  /** Drop finished records whose command expired more than `retentionMs` ago. A replay of those is refused by expiry anyway. */
  purge(now: number): number {
    let n = 0;
    for (const [id, r] of this.map) if (isTerminal(r.state) && now > r.expiresAt + this.retentionMs) { this.map.delete(id); n++; }
    return n;
  }
  get size(): number { return this.map.size; }
}

interface Prepared { command: AnyOrderCommand; fingerprint: string; preview: OrderPreview; gate: GateResult }

export type EvidenceVerdict = { verdict: 'confirmed'; note: string } | { verdict: 'no_trace'; note: string } | { verdict: 'inconclusive'; note: string };

const near = (a: number | null | undefined, b: number | null | undefined, tol = 1e-6) => (a == null || a === 0 ? b == null || b === 0 : b != null && Math.abs(a - b) <= tol);

/** Decide from broker evidence what happened to a command whose send result was unknown. Pure. */
export function judgeEvidence(rec: Pick<OrderRecord, 'command' | 'broker' | 'volumeBefore'>, ev: Evidence): EvidenceVerdict {
  if (!ev.queried.positions || !ev.queried.orders || !ev.queried.deals || !ev.queried.historyOrders) return { verdict: 'inconclusive', note: 'MT5 could not return all of positions, orders and deal history.' };
  const c = rec.command;
  switch (c.type) {
    case 'open_market': case 'open_pending': {
      const hit = ev.positions[0] ?? ev.orders[0] ?? ev.deals.find((d) => d.entry === 'in') ?? ev.historyOrders[0];
      if (hit) return { verdict: 'confirmed', note: 'MT5 holds a position/order/deal tagged with this command.' };
      return { verdict: 'no_trace', note: 'No position, order, deal or history entry carries this command tag.' };
    }
    case 'close_position': case 'partial_close': {
      if (ev.deals.some((d) => d.entry === 'out' || d.entry === 'out_by')) return { verdict: 'confirmed', note: 'MT5 holds a closing deal tagged with this command.' };
      const pos = ev.target?.position;
      if (!pos) return { verdict: 'inconclusive', note: 'The position is gone but no tagged closing deal was found (it may have been closed by a stop, take profit or by hand in MT5).' };
      const before = rec.volumeBefore;
      if (before !== null && pos.volume < before - 1e-9) return { verdict: 'inconclusive', note: 'The position volume went down but no tagged deal was found. Check the MT5 history.' };
      return { verdict: 'no_trace', note: 'The position is still open and no closing deal carries this command tag.' };
    }
    case 'modify_sltp': {
      const t = ev.target;
      const cur = c.ticketKind === 'position' ? t?.position : t?.order;
      if (!cur) return { verdict: 'inconclusive', note: 'The target is no longer in MT5, so the change cannot be checked.' };
      const slOk = c.sl === undefined || near(cur.sl, c.sl);
      const tpOk = c.tp === undefined || near(cur.tp, c.tp);
      if (slOk && tpOk) return { verdict: 'confirmed', note: 'MT5 shows the requested SL/TP on the target.' };
      return { verdict: 'no_trace', note: 'MT5 still shows the old SL/TP on the target.' };
    }
    case 'cancel_pending': {
      if (ev.target?.order) return { verdict: 'no_trace', note: 'The pending order is still in MT5.' };
      return { verdict: 'inconclusive', note: 'The pending order is gone, but it may have been filled, expired or cancelled by hand.' };
    }
    case 'close_all': return { verdict: 'inconclusive', note: 'Check each position of the bulk close individually.' };
  }
}

export function toBridgeCall(c: OrderCommand): { action: string; body: Record<string, unknown> } {
  const base = { commandId: c.commandId, symbol: c.symbol };
  switch (c.type) {
    case 'open_market': return { action: 'open_market', body: { ...base, side: c.side, volume: c.volume, sl: c.sl, tp: c.tp, deviationPoints: c.deviationPoints } };
    case 'open_pending': return { action: 'open_pending', body: { ...base, orderType: c.orderType, price: c.price, volume: c.volume, sl: c.sl, tp: c.tp, ...(c.expiration ? { expiration: c.expiration } : {}) } };
    case 'modify_sltp': return { action: 'modify_sltp', body: { ...base, ticket: c.ticket, ticketKind: c.ticketKind, ...(c.sl !== undefined ? { sl: c.sl } : {}), ...(c.tp !== undefined ? { tp: c.tp } : {}) } };
    case 'close_position': return { action: 'close_position', body: { ...base, ticket: c.ticket } };
    case 'partial_close': return { action: 'partial_close', body: { ...base, ticket: c.ticket, volume: c.volume } };
    case 'cancel_pending': return { action: 'cancel_pending', body: { ...base, ticket: c.ticket } };
  }
}

export class OrderEngine {
  readonly registry: CommandRegistry;
  private readonly prepared = new Map<string, Prepared>();
  private readonly inflight = new Map<string, Promise<OrderRecord>>();
  private readonly touched = new Map<number, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private kill = false;
  private readonly now: () => number;
  private readonly noTraceGap: number;

  constructor(private readonly o: EngineOptions) {
    this.registry = new CommandRegistry(o.retentionMs);
    this.now = o.now ?? Date.now;
    this.noTraceGap = o.noTraceGapMs ?? 5000;
  }

  // -- switches -------------------------------------------------------------------------------------------
  get killSwitch(): boolean { return this.kill; }
  setKillSwitch(on: boolean): void {
    if (this.kill === on) return;
    this.kill = on;
    this.activity({ commandId: null, kind: 'kill_switch', actor: 'manual', state: null, label: on ? 'Stop AI actions: ON (AI-origin commands blocked)' : 'Stop AI actions: OFF', detail: { on } });
  }

  /** True when a position/order ticket was touched by one of OUR commands in the last seconds (so a change there is not "external"). */
  isOwnRecent(ticket: number, now = this.now()): boolean {
    const until = this.touched.get(ticket);
    return until !== undefined && now <= until;
  }

  // -- restore after restart ------------------------------------------------------------------------------
  /** Reload persisted records. A command that was mid-send when the app died becomes unknown_reconcile (never resent). */
  restore(records: OrderRecord[]): void {
    for (const r of records) {
      let rec = r;
      if (rec.state === 'sent_to_broker') rec = this.moved(rec, 'unknown_reconcile', 'The app stopped while this command was being sent. It will be reconciled with MT5, not resent.', { reason: 'Interrupted while sending.' });
      else if (rec.state === 'requested') rec = this.moved(rec, 'validation_failed', 'The app stopped before this command was sent. Nothing was sent.', { reason: 'Interrupted before sending.' });
      this.registry.set(rec);
    }
  }

  // -- prepare --------------------------------------------------------------------------------------------
  async prepare(raw: unknown): Promise<PrepareResult> {
    const parsed = parseOrderCommand(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`).join('; ') };
    const cmd = parsed.data;
    const existing = this.registry.get(cmd.commandId);
    if (existing) {
      if (existing.fingerprint !== commandFingerprint(cmd)) return { ok: false, error: `commandId ${cmd.commandId} was already used for a different command.` };
      return { ok: true, commandId: cmd.commandId, existing };
    }
    const fp = commandFingerprint(cmd);
    const prev = this.prepared.get(cmd.commandId);
    if (prev && prev.fingerprint !== fp) return { ok: false, error: `commandId ${cmd.commandId} was already prepared for a different command.` };
    let snap: BrokerSnapshot;
    try { snap = await this.o.broker.snapshot(); } catch (e) { return { ok: false, error: `MT5 is not reachable: ${e instanceof Error ? e.message : String(e)}` }; }
    const gate = await this.runGate(cmd, snap, true);
    const preview = previewCommand(cmd, {
      currency: snap.account?.currency ?? '', demo: snap.account ? snap.account.demo : null, pipSize: this.o.settings().pipSize, spec: snap.spec,
      bid: snap.tick?.bid ?? null, ask: snap.tick?.ask ?? null, balance: snap.account?.balance ?? null, positions: snap.positions,
      orders: snap.orders.map((x) => ({ ticket: x.ticket, type: x.type, volume: x.volume, priceOpen: x.priceOpen })),
    });
    this.prepared.set(cmd.commandId, { command: cmd, fingerprint: fp, preview, gate });
    this.activity({ commandId: cmd.commandId, kind: 'prepared', actor: cmd.actor, state: null, label: `Prepared: ${preview.title}${gate.ok ? '' : ` (would be blocked: ${gate.failed?.rule})`}`, detail: { preview: preview.text, gate: gate.failed } });
    return { ok: true, commandId: cmd.commandId, command: cmd, preview, gate, executable: gate.ok, account: snap.account ? { demo: snap.account.demo, currency: snap.account.currency, balance: snap.account.balance } : null, expiresAt: cmd.expiresAt, existing: null };
  }

  private async runGate(cmd: AnyOrderCommand, snap: BrokerSnapshot, userConfirmed: boolean, relaxSltp = false): Promise<GateResult> {
    const settings = this.o.settings();
    const now = this.now();
    let pnl: number | null = null;
    const since = dailyWindowStart(now, settings.risk.dailyResetTimezone, snap.tick?.time ?? null);
    if (since !== null) {
      try { pnl = realizedPnlSince(await this.o.broker.deals(since), since); } catch { pnl = null; }
    }
    const input: GateInput = {
      command: cmd, now, userConfirmed,
      settings: {
        tradingEnabled: settings.tradingEnabled, risk: settings.risk,
        aiPermissions: relaxSltp ? { ...settings.aiPermissions, sltpAndPartialClose: true } : settings.aiPermissions,
        allowedSymbols: settings.allowedSymbols, allowLive: false,
      },
      killSwitch: this.kill, account: snap.account, spec: snap.spec, tick: snap.tick, positions: snap.positions, orders: snap.orders,
      dailyRealizedPnl: pnl,
      unresolved: this.registry.unresolved().map((r) => ({ commandId: r.commandId, type: r.type, ticket: r.ticket })),
    };
    return evaluateGate(input);
  }

  // -- confirm --------------------------------------------------------------------------------------------
  /** Execute a prepared command. Idempotent: the same commandId returns the same record and never reaches the broker twice. */
  confirm(commandId: string): Promise<OrderRecord> {
    const done = this.registry.get(commandId);
    if (done) return Promise.resolve(done);
    const running = this.inflight.get(commandId);
    if (running) return running;
    const p = this.enqueue(() => this.confirmInner(commandId)).finally(() => this.inflight.delete(commandId));
    this.inflight.set(commandId, p);
    return p;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private newRecord(cmd: AnyOrderCommand, preview: string): OrderRecord {
    const now = this.now();
    return {
      commandId: cmd.commandId, type: cmd.type, actor: cmd.actor, command: cmd, fingerprint: commandFingerprint(cmd), state: 'requested', createdAt: now, expiresAt: cmd.expiresAt,
      updatedAt: now, preview, failedRule: null, reason: null, broker: null, riskSnapshot: null, ticket: 'ticket' in cmd ? cmd.ticket : null, volumeBefore: null, noTraceChecks: 0, firstNoTraceAt: null,
      children: [], history: [{ at: now, state: 'requested', note: 'Confirmed by the user; checking the risk gate.' }],
    };
  }

  private moved(rec: OrderRecord, state: OrderState, note: string, patch: Partial<OrderRecord> = {}): OrderRecord {
    if (rec.state !== state && !canTransition(rec.state, state)) throw new Error(`Illegal order state change ${rec.state} -> ${state}`);
    const at = this.now();
    const next: OrderRecord = { ...rec, ...patch, state, updatedAt: at, history: [...rec.history, { at, state, note }] };
    this.registry.set(next);
    this.o.onRecord?.(next);
    this.activity({ commandId: next.commandId, kind: 'state', actor: next.actor, state, label: `${next.type} ${next.commandId}: ${state}${next.reason ? ` - ${next.reason}` : ''}`, detail: { note, failedRule: next.failedRule, broker: next.broker } });
    return next;
  }

  private activity(a: Omit<ActivityEntry, 'at'>): void { this.o.onActivity?.({ at: this.now(), ...a }); }

  private async confirmInner(commandId: string): Promise<OrderRecord> {
    const again = this.registry.get(commandId);
    if (again) return again;
    const prep = this.prepared.get(commandId);
    if (!prep) throw new Error(`Command ${commandId} was never prepared (or its preview expired). Prepare it again.`);
    const cmd = prep.command;
    let rec = this.newRecord(cmd, prep.preview.text);
    // Register FIRST: from here on a duplicate can only ever get this record back.
    this.registry.set(rec);
    this.o.onRecord?.(rec);
    this.prepared.delete(commandId);
    this.registry.purge(this.now());

    let snap: BrokerSnapshot;
    try { snap = await this.o.broker.snapshot(); } catch (e) {
      return this.moved(rec, 'validation_failed', 'MT5 not reachable.', { reason: `MT5 is not reachable, nothing was sent: ${e instanceof Error ? e.message : String(e)}` });
    }
    const gate = await this.runGate(cmd, snap, true);
    if (!gate.ok) return this.moved(rec, 'validation_failed', gate.failed!.message, { failedRule: gate.failed!.rule, reason: gate.failed!.message });

    if (cmd.type === 'close_all') return this.executeCloseAll(rec, cmd, snap);
    const vb = (cmd.type === 'close_position' || cmd.type === 'partial_close') ? (snap.positions.find((p) => p.ticket === cmd.ticket)?.volume ?? null) : null;
    rec = this.moved(rec, 'sent_to_broker', 'Sent to the MT5 bridge.', { riskSnapshot: this.snapshotOf(cmd, snap, gate), volumeBefore: vb });
    return this.send(rec, cmd, snap);
  }

  private snapshotOf(cmd: AnyOrderCommand, snap: BrokerSnapshot, gate: GateResult): RiskSnapshot {
    let slDistance: number | null = null;
    if (cmd.type === 'open_market' && cmd.sl !== null && snap.tick) slDistance = Math.abs((cmd.side === 'buy' ? snap.tick.ask : snap.tick.bid) - cmd.sl);
    if (cmd.type === 'open_pending' && cmd.sl !== null) slDistance = Math.abs(cmd.price - cmd.sl);
    return {
      at: this.now(), balance: snap.account?.balance ?? null, riskMoney: gate.numbers.riskMoney, riskPct: gate.numbers.riskPct, slDistance,
      spread: snap.tick ? snap.tick.ask - snap.tick.bid : null, bid: snap.tick?.bid ?? null, ask: snap.tick?.ask ?? null,
    };
  }

  private async send(rec: OrderRecord, cmd: OrderCommand, snap: BrokerSnapshot): Promise<OrderRecord> {
    const { action, body } = toBridgeCall(cmd);
    let out: BrokerOutcome;
    try {
      out = await this.o.broker.execute(action, body);
    } catch (e) {
      if (e instanceof BrokerNotSent) return this.moved(rec, 'rejected', `Not sent: ${e.message}`, { reason: e.message, broker: { status: 'not_sent', message: e.message, stage: e.code } });
      const msg = e instanceof Error ? e.message : String(e);
      return this.moved(rec, 'unknown_reconcile', 'The result is unknown. It will be checked in MT5, not resent.', { reason: `No reliable answer from the bridge (${msg}). The order may or may not have been executed.`, broker: { status: 'unknown', message: msg } });
    }
    const summary: BrokerResultSummary = {
      status: out.status, stage: out.stage, retcode: out.retcode ?? null, retcodeName: out.retcodeName, message: out.message, order: out.order ?? null, deal: out.deal ?? null,
      positionTicket: out.positionTicket ?? null, volume: out.volume ?? null, price: out.price ?? null, duplicate: out.duplicate,
    };
    const withBefore = summary;
    const ticket = (out.positionTicket ?? out.order ?? rec.ticket) ?? null;
    if (out.status === 'done' || out.status === 'partial') {
      for (const t of [out.positionTicket, out.order, rec.ticket]) if (t) this.touched.set(t, this.now() + OWN_WINDOW_MS);
      const note = out.status === 'partial' ? `Executed only partially: ${out.message ?? ''}` : `${out.retcodeName ?? 'DONE'}: ${out.message ?? ''}`;
      return this.moved(rec, 'confirmed', note, { broker: withBefore, ticket, reason: out.status === 'partial' ? (out.message ?? 'Partially filled.') : null });
    }
    if (out.status === 'rejected') return this.moved(rec, 'rejected', out.message ?? 'Rejected by the broker.', { broker: withBefore, reason: `${out.retcodeName ?? 'REJECTED'}: ${out.message ?? 'The broker rejected the request.'}` });
    return this.moved(rec, 'unknown_reconcile', 'The result is unknown. It will be checked in MT5, not resent.', { broker: withBefore, ticket, reason: out.message ?? 'The broker gave no reliable answer.' });
  }

  private async executeCloseAll(rec: OrderRecord, cmd: Extract<AnyOrderCommand, { type: 'close_all' }>, snap: BrokerSnapshot): Promise<OrderRecord> {
    rec = this.moved(rec, 'sent_to_broker', `Closing ${snap.positions.length} position(s) one by one.`);
    const children: string[] = [];
    const lines: string[] = [];
    for (const p of snap.positions) {
      const childId = `${cmd.commandId.slice(0, 60)}:${p.ticket}`;
      const child: ClosePositionCommand = { type: 'close_position', commandId: childId, actor: cmd.actor, createdAt: cmd.createdAt, expiresAt: cmd.expiresAt, symbol: cmd.symbol, ticket: p.ticket, reason: `close_all ${cmd.commandId}` };
      children.push(childId);
      let cr = this.registry.get(childId);
      if (!cr) {
        cr = this.newRecord(child, `Close position #${p.ticket} (part of close all)`);
        this.registry.set(cr);
        this.o.onRecord?.(cr);
        let fresh: BrokerSnapshot;
        try { fresh = await this.o.broker.snapshot(); } catch (e) { cr = this.moved(cr, 'validation_failed', 'MT5 not reachable', { reason: String(e instanceof Error ? e.message : e) }); lines.push(`#${p.ticket}: ${cr.reason}`); break; }
        const g = await this.runGate(child, fresh, true, true);
        if (!g.ok) { cr = this.moved(cr, 'validation_failed', g.failed!.message, { failedRule: g.failed!.rule, reason: g.failed!.message }); lines.push(`#${p.ticket}: ${cr.reason}`); break; }
        cr = this.moved(cr, 'sent_to_broker', 'Sent to the MT5 bridge.');
        cr = await this.send(cr, child, fresh);
      }
      if (cr.state === 'confirmed') lines.push(`#${p.ticket}: closed`);
      else { lines.push(`#${p.ticket}: ${cr.state}${cr.reason ? ` (${cr.reason})` : ''}`); break; }
    }
    const kids = children.map((id) => this.registry.get(id)).filter((x): x is OrderRecord => !!x);
    const allClosed = kids.length === snap.positions.length && kids.every((k) => k.state === 'confirmed');
    const unknown = kids.some((k) => k.state === 'unknown_reconcile');
    const summary = lines.join('; ');
    if (allClosed) return this.moved(rec, 'confirmed', summary, { children, reason: null });
    if (unknown) return this.moved(rec, 'unknown_reconcile', summary, { children, reason: `Stopped: ${summary}` });
    return this.moved(rec, 'rejected', summary, { children, reason: `Stopped after an error. ${summary}` });
  }

  // -- reconcile ------------------------------------------------------------------------------------------
  /**
   * Resolve an unknown command by LOOKING in MT5 (find by tag/magic). Never resends. A "no trace" verdict has to be seen
   * twice, `noTraceGapMs` apart, before the command is called rejected; anything ambiguous stays unknown_reconcile.
   */
  async reconcile(commandId: string): Promise<OrderRecord> {
    return this.enqueue(async () => {
      let rec = this.registry.get(commandId);
      if (!rec) throw new Error(`Unknown command ${commandId}.`);
      if (rec.state !== 'unknown_reconcile') return rec;
      if (rec.type === 'close_all') {
        const kids = rec.children.map((id) => this.registry.get(id)).filter((x): x is OrderRecord => !!x);
        for (const k of kids) if (k.state === 'unknown_reconcile') await this.reconcileInner(k);
        const after = rec.children.map((id) => this.registry.get(id));
        if (after.every((k) => k?.state === 'confirmed') && after.length > 0) return this.moved(rec, 'confirmed', 'All child closes confirmed after reconciliation.', { reason: null });
        return rec;
      }
      return this.reconcileInner(rec);
    });
  }

  private async reconcileInner(rec0: OrderRecord): Promise<OrderRecord> {
    let rec = rec0;
    let ev: Evidence;
    try { ev = await this.o.broker.find(rec.commandId, rec.ticket); } catch (e) {
      this.activity({ commandId: rec.commandId, kind: 'reconcile', actor: rec.actor, state: rec.state, label: `Reconcile ${rec.commandId}: MT5 not reachable`, detail: { error: String(e) } });
      return rec;
    }
    const v = judgeEvidence(rec, ev);
    this.activity({ commandId: rec.commandId, kind: 'reconcile', actor: rec.actor, state: rec.state, label: `Reconcile ${rec.commandId}: ${v.verdict} - ${v.note}`, detail: { verdict: v.verdict } });
    if (v.verdict === 'confirmed') {
      const pos = ev.positions[0];
      const ticketHit = pos?.ticket ?? ev.orders[0]?.ticket ?? ev.deals[0]?.positionId ?? rec.ticket;
      if (ticketHit) this.touched.set(ticketHit, this.now() + OWN_WINDOW_MS);
      return this.moved(rec, 'confirmed', `Confirmed from MT5 evidence: ${v.note}`, { reason: null, ticket: ticketHit ?? null });
    }
    if (v.verdict === 'inconclusive') {
      rec = { ...rec, noTraceChecks: 0, firstNoTraceAt: null, reason: `${rec.reason ?? ''} ${v.note}`.trim() };
      this.registry.set(rec); this.o.onRecord?.(rec);
      return rec;
    }
    const now = this.now();
    const first = rec.firstNoTraceAt ?? now;
    const checks = rec.noTraceChecks + 1;
    if (checks >= 2 && now - first >= this.noTraceGap) {
      return this.moved(rec, 'rejected', `No trace in MT5 on ${checks} checks: ${v.note}`, { reason: `Not executed: ${v.note} (checked ${checks} times).`, noTraceChecks: checks, firstNoTraceAt: first });
    }
    rec = { ...rec, noTraceChecks: checks, firstNoTraceAt: first, updatedAt: now };
    this.registry.set(rec); this.o.onRecord?.(rec);
    return rec;
  }

  /** Reconcile every unknown command (called by a timer in the app). */
  async reconcileAll(): Promise<OrderRecord[]> {
    const out: OrderRecord[] = [];
    for (const r of this.registry.unresolved()) out.push(await this.reconcile(r.commandId));
    return out;
  }

  /** Owner decision after checking MT5 by hand. Logged. This is the only way out of an ambiguous unknown_reconcile. */
  resolve(commandId: string, outcome: 'confirmed' | 'rejected', note: string): OrderRecord {
    const rec = this.registry.get(commandId);
    if (!rec) throw new Error(`Unknown command ${commandId}.`);
    if (rec.state !== 'unknown_reconcile') return rec;
    const next = this.moved(rec, outcome, `Resolved by the owner: ${note}`, { reason: outcome === 'rejected' ? `Marked as NOT executed by the owner: ${note}` : null });
    this.activity({ commandId, kind: 'resolved', actor: 'manual', state: outcome, label: `Owner resolved ${commandId} as ${outcome}: ${note}`, detail: { note } });
    return next;
  }

  records(): OrderRecord[] { return this.registry.all().sort((a, b) => b.createdAt - a.createdAt); }
}
