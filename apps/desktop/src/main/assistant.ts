import type { DatabaseSync } from 'node:sqlite';
import {
  AssistantSettingsSchema, TradePlanSchema, fmtPips, manageDecisions, planOrder, priceToPips, profitPips, stampCommand, zoneBroken, zoneReached,
  type AnyOrderCommand, type AppConfig, type BrokerSnapshot, type ManageState, type OrderRecord, type PrepareResult, type TradePlan,
} from '@aurum/core';

/**
 * Trade Assistant: arms approved plans, watches the price, asks (or acts) when the zone is reached, and manages open trades
 * with pip-based rules. It never decides anything with an AI call: every step is arithmetic on real ticks. All orders go
 * through the same OrderEngine and RiskGate as manual orders; the gate's `rule` actor limits what is possible without a click.
 */
export interface AssistantDeps {
  getConfig(): AppConfig;
  engine: { prepare(raw: unknown): Promise<PrepareResult>; confirm(commandId: string): Promise<OrderRecord> };
  snapshot(): Promise<BrokerSnapshot>;
  plans: PlanStore;
  /** Small persisted memory for management state. */
  kv: { get(key: string): string | null; set(key: string, json: string): void };
  /** Message to the user (desktop toast + WhatsApp). */
  notify(text: string, priority: 'critical' | 'normal'): void;
  /** Ask the user whether to take a trade (renderer dialog + WhatsApp options). */
  ask(plan: TradePlan, text: string): void;
  changed(): void;
  /** Called whenever a plan is created or changes (the paper-trading shadow follows it). */
  onPlan?(plan: TradePlan): void;
  now?: () => number;
  newId?: () => string;
}

export interface PlanStore { list(): TradePlan[]; save(p: TradePlan): void }

const WORKSPACE = 'default';
const LIVE: ReadonlySet<string> = new Set(['armed', 'asking', 'placing']);

export class SqlitePlanStore implements PlanStore {
  constructor(private readonly db: () => DatabaseSync) {}
  list(): TradePlan[] {
    const rows = this.db().prepare('SELECT json FROM trade_plans WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 200').all(WORKSPACE) as { json: string }[];
    return rows.flatMap((r) => { const p = TradePlanSchema.safeParse(JSON.parse(r.json)); return p.success ? [p.data] : []; });
  }
  save(p: TradePlan): void {
    this.db().prepare('INSERT INTO trade_plans (id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id, workspace_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(p.id, WORKSPACE, JSON.stringify(p), Date.now());
  }
}

/** One plain sentence about a plan, always in pips. */
export function describePlan(p: TradePlan, now = Date.now()): string {
  const hrs = Math.max(0, Math.round((p.expiresAt - now) / 3600_000));
  return `${p.side.toUpperCase()} ${p.entry === 'limit' ? 'limit at' : 'when price reaches'} ${p.zone.low}-${p.zone.high}: stop ${p.slPips} pips${p.tpPips ? `, target ${p.tpPips} pips` : ''}, risk ${p.riskPct}%, valid ${hrs} h.${p.note ? ` ${p.note}` : ''}`;
}

export class AssistantService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private busy = new Set<string>();
  private lastManage = 0;
  private managing = false;
  private backoff = new Map<string, number>();

  constructor(private readonly d: AssistantDeps) {
    this.now = d.now ?? Date.now;
    this.newId = d.newId ?? (() => `plan-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`);
  }

  // ----- plans -----------------------------------------------------------------------------------

  list(): TradePlan[] { return this.d.plans.list(); }
  get(id: string): TradePlan | null { return this.list().find((p) => p.id === id) ?? null; }
  /** Ids the risk gate accepts for assistant-opened orders. */
  approvedIds(): string[] { return this.list().filter((p) => LIVE.has(p.status)).map((p) => p.id); }
  proposedSince(ms: number): TradePlan | null { return this.list().find((p) => p.status === 'proposed' && p.createdAt >= ms) ?? null; }

  private save(p: TradePlan, patch: Partial<TradePlan> = {}): TradePlan {
    const next = TradePlanSchema.parse({ ...p, ...patch });
    this.d.plans.save(next);
    this.d.changed();
    this.d.onPlan?.(next);
    return next;
  }

  create(input: Omit<Partial<TradePlan>, 'id' | 'createdAt' | 'status'> & Pick<TradePlan, 'side' | 'zone' | 'createdBy'>): TradePlan {
    const cfg = this.d.getConfig().assistant;
    const now = this.now();
    const plan = TradePlanSchema.parse({
      entry: 'touch', slPips: cfg.defaults.slPips, tpPips: cfg.defaults.tpPips, riskPct: cfg.defaults.riskPct, autoTake: false,
      expiresAt: now + cfg.defaults.expiryHours * 3600_000, note: '', statusDetail: 'Waiting for your approval.', ...input,
      id: this.newId(), createdAt: now, status: 'proposed',
    });
    this.d.plans.save(plan);
    this.d.changed();
    this.d.onPlan?.(plan);
    return plan;
  }

  /** The user's approval of this exact plan. For a limit plan the pending order is placed now. */
  async approve(id: string, o: { autoTake?: boolean } = {}): Promise<TradePlan> {
    const plan = this.get(id);
    if (!plan) throw new Error('Plan not found.');
    if (plan.status !== 'proposed') throw new Error(`This plan is already ${plan.status}.`);
    const cfg = this.d.getConfig();
    if (!cfg.assistant.enabled) throw new Error('Turn on the Trade Assistant first (Settings > Trading > Assistant).');
    if (!cfg.trading.enabled) throw new Error('Trading is off (Settings > Trading).');
    if (plan.expiresAt <= this.now()) return this.save(plan, { status: 'expired', statusDetail: 'Expired before it was approved.' });
    const armed = this.save(plan, { status: 'armed', approvedAt: this.now(), autoTake: o.autoTake ?? plan.autoTake, statusDetail: plan.entry === 'limit' ? 'Placing the pending order…' : `Waiting for price to reach ${plan.zone.low}-${plan.zone.high}.` });
    if (armed.entry === 'limit') return this.place(armed, 'approval');
    return armed;
  }

  cancel(id: string, why = 'Cancelled by you.'): TradePlan {
    const plan = this.get(id);
    if (!plan) throw new Error('Plan not found.');
    if (plan.status === 'filled' || plan.status === 'cancelled' || plan.status === 'expired') return plan;
    return this.save(plan, { status: 'cancelled', statusDetail: why });
  }

  /** "Take it": the user said yes to an armed or asking plan (in the app or on WhatsApp). */
  async take(id: string): Promise<TradePlan> {
    const plan = this.get(id);
    if (!plan) throw new Error('Plan not found.');
    if (plan.status !== 'armed' && plan.status !== 'asking') throw new Error(`This plan is ${plan.status}, so it cannot be taken now.`);
    return this.place(plan, 'user');
  }

  skip(id: string): TradePlan {
    const plan = this.get(id);
    if (!plan) throw new Error('Plan not found.');
    return this.save(plan, { status: 'skipped', statusDetail: 'You skipped this one.' });
  }

  /** Builds the order for the plan at today's price and sends it through prepare -> confirm. */
  private async place(plan: TradePlan, by: 'user' | 'auto' | 'approval'): Promise<TradePlan> {
    if (this.busy.has(plan.id)) return plan;
    this.busy.add(plan.id);
    try {
      let cur = this.save(plan, { status: 'placing', statusDetail: 'Checking the risk rules and placing the order…' });
      const cfg = this.d.getConfig();
      let snap: BrokerSnapshot;
      try { snap = await this.d.snapshot(); } catch (e) { return this.block(cur, `MT5 is not reachable: ${e instanceof Error ? e.message : String(e)}`); }
      const order = planOrder(cur, { tick: snap.tick, spec: snap.spec, balance: snap.account?.balance ?? null, pipSize: cfg.pipSize });
      if ('error' in order) return this.block(cur, order.error);
      const cmd = stampCommand(order.body as { type: string }, { actor: 'rule', symbol: cfg.brokerSymbol });
      const prep = await this.d.engine.prepare(cmd as unknown as AnyOrderCommand);
      if (!prep.ok) return this.block(cur, prep.error);
      if (!('preview' in prep)) return this.block(cur, 'This command was already handled.');
      if (!prep.gate.ok) return this.block(cur, prep.gate.failed?.message ?? 'The risk rules refused this order.');
      cur = this.save(cur, { commandId: prep.commandId });
      const rec = await this.d.engine.confirm(prep.commandId);
      const where = `${plan.side === 'buy' ? 'BUY' : 'SELL'} ${order.lots} lot at ${order.entry.toFixed(2)}, SL ${order.sl.toFixed(2)} (${order.slPips} pips)${order.tp !== null ? `, TP ${order.tp.toFixed(2)} (${order.tpPips} pips)` : ''}`;
      if (rec.state === 'confirmed') {
        const ticket = rec.broker?.positionTicket ?? rec.ticket ?? undefined;
        const saved = this.save(cur, { status: 'filled', ...(ticket ? { ticket } : {}), statusDetail: plan.entry === 'limit' ? `Pending order placed: ${where}.` : `Trade opened: ${where}.` });
        this.d.notify(`${plan.entry === 'limit' ? 'Pending order placed' : 'Trade taken'}${by === 'auto' ? ' automatically' : ''}: ${where}. Risk ${plan.riskPct}% of balance.`, 'normal');
        return saved;
      }
      if (rec.state === 'unknown_reconcile') {
        const saved = this.save(cur, { status: 'filled', statusDetail: `Result unknown: check MT5 before doing anything else. ${rec.reason ?? ''}`.trim() });
        this.d.notify(`The order for your plan may or may not have reached MT5 (${where}). Check MT5; Aurum will not send it again.`, 'critical');
        return saved;
      }
      return this.block(cur, rec.reason ?? `The order was ${rec.state}.`);
    } catch (e) {
      const p = this.get(plan.id) ?? plan;
      return this.block(p, e instanceof Error ? e.message : String(e));
    } finally { this.busy.delete(plan.id); }
  }

  private block(plan: TradePlan, why: string): TradePlan {
    const saved = this.save(plan, { status: 'blocked', statusDetail: why.slice(0, 380) });
    this.d.notify(`Plan not placed: ${why}`, 'normal');
    return saved;
  }

  // ----- price events ----------------------------------------------------------------------------

  /** Called for every live tick. Cheap when nothing is armed. */
  async onTick(tick: { bid: number; ask: number }): Promise<void> {
    const cfg = this.d.getConfig();
    const now = this.now();
    for (const plan of this.list()) {
      if (!LIVE.has(plan.status) && plan.status !== 'proposed') continue;
      if (plan.expiresAt <= now) { this.save(plan, { status: 'expired', statusDetail: 'The plan expired before price reached the zone.' }); continue; }
      if (plan.status !== 'armed' || plan.entry !== 'touch' || !cfg.assistant.enabled) continue;
      if (zoneBroken(plan, tick)) { this.block(plan, 'Price went through the zone without a touch, so the idea is broken. Plan stopped.'); continue; }
      if (!zoneReached(plan, tick)) continue;
      if (plan.autoTake) { void this.place(plan, 'auto'); continue; }
      const asking = this.save(plan, { status: 'asking', statusDetail: 'Zone reached. Waiting for your answer.' });
      const px = plan.side === 'buy' ? tick.ask : tick.bid;
      this.d.ask(asking, `Zone reached: price ${px.toFixed(2)} is inside ${plan.zone.low}-${plan.zone.high}. Take the ${plan.side.toUpperCase()}? SL ${plan.slPips} pips${plan.tpPips ? `, TP ${plan.tpPips} pips` : ''}, risk ${plan.riskPct}%.${plan.note ? ` ${plan.note}` : ''}`);
    }
    void this.manage(tick);
  }

  // ----- management in pips ----------------------------------------------------------------------

  private manageState(): Record<string, ManageState> {
    try { return JSON.parse(this.d.kv.get('assist_manage') ?? '{}') as Record<string, ManageState>; } catch { return {}; }
  }

  private async manage(tick: { bid: number; ask: number }): Promise<void> {
    const cfg = this.d.getConfig();
    if (!cfg.assistant.enabled || !cfg.assistant.autoManage || !cfg.trading.enabled) return;
    const now = this.now();
    if (this.managing || now - this.lastManage < 1500) return;
    this.managing = true; this.lastManage = now;
    try {
      const snap = await this.d.snapshot();
      const state = this.manageState();
      const live = new Set(snap.positions.map((p) => String(p.ticket)));
      for (const k of Object.keys(state)) if (!live.has(k)) delete state[k]; // forget closed positions
      for (const pos of snap.positions) {
        if (pos.symbol !== cfg.brokerSymbol) continue;
        const st = state[String(pos.ticket)] ?? { partialDone: false };
        const actions = manageDecisions(pos, snap.tick ?? tick, cfg.assistant.rules, st, { pipSize: cfg.pipSize, spec: snap.spec });
        for (const a of actions) {
          const key = `${a.ticket}:${a.kind}`;
          if ((this.backoff.get(key) ?? 0) > now) continue;
          const body = a.kind === 'sl'
            ? { type: 'modify_sltp', ticket: a.ticket, ticketKind: 'position', sl: a.newSl, reason: a.text.slice(0, 300) }
            : { type: 'partial_close', ticket: a.ticket, volume: a.volume, reason: a.text.slice(0, 300) };
          const cmd = stampCommand(body, { actor: 'rule', symbol: cfg.brokerSymbol });
          const prep = await this.d.engine.prepare(cmd as unknown as AnyOrderCommand);
          if (!prep.ok || !('preview' in prep) || !prep.gate.ok) {
            this.backoff.set(key, now + 30_000); // do not hammer the gate every second
            continue;
          }
          const rec = await this.d.engine.confirm(prep.commandId);
          if (rec.state === 'confirmed') {
            if (a.kind === 'partial') state[String(pos.ticket)] = { ...st, partialDone: true };
            const pips = profitPips(pos, snap.tick ?? tick, cfg.pipSize);
            this.d.notify(`#${a.ticket} ${a.text}. Now ${fmtPips(pips)}.`, 'normal');
          } else this.backoff.set(key, now + 60_000);
        }
        state[String(pos.ticket)] = state[String(pos.ticket)] ?? st;
      }
      this.d.kv.set('assist_manage', JSON.stringify(state));
    } catch { /* the next tick tries again */ } finally { this.managing = false; }
  }

  /** Pips view of open positions for the UI and the AI. */
  pipsView(snap: BrokerSnapshot, pipSize: number) {
    return snap.positions.map((p) => ({
      ticket: p.ticket, side: p.type, lots: p.volume, open: p.priceOpen,
      pips: snap.tick ? Math.round(profitPips(p, snap.tick, pipSize) * 10) / 10 : null,
      // Signed in the direction of profit: negative = pips at risk below/above entry, positive = profit already locked in.
      slPips: p.sl === null ? null : Math.round(priceToPips(p.type === 'buy' ? p.sl - p.priceOpen : p.priceOpen - p.sl, pipSize) * 10) / 10,
      tpPips: p.tp === null ? null : Math.round(priceToPips(Math.abs(p.tp - p.priceOpen), pipSize) * 10) / 10,
    }));
  }
}

export { AssistantSettingsSchema };
