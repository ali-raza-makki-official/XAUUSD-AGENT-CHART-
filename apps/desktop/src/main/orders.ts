import { BrokerNotSent, BrokerDealSchema, type BrokerDeal, BrokerOrderSchema, BrokerOutcomeSchema, BrokerPositionSchema, EvidenceSchema, OrderEngine, SymbolSpecSchema, type ActivityEntry, type AppConfig, type BrokerPort, type OrderRecord } from '@aurum/core';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeManager } from './bridge';

const WORKSPACE = 'default';

/** BrokerPort over the local MT5 bridge. A non-200 means order_send was NOT called; any thrown error on execute means "unknown". */
function bridgePort(bridge: BridgeManager): BrokerPort {
  return {
    async snapshot() {
      const [acc, spec, pos, ord] = await Promise.all([
        bridge.http('GET', '/account'), bridge.http('GET', '/symbol'), bridge.http('GET', '/positions'), bridge.http('GET', '/orders'),
      ]);
      if (acc.status !== 200) throw new Error(acc.json?.error ?? 'MT5 account unavailable');
      const a = acc.json;
      const tick = bridge.lastTick;
      return {
        account: { demo: !!a.demo, balance: Number(a.balance ?? 0), equity: a.equity, currency: String(a.currency), login: a.login, server: a.server },
        tick: tick ? { bid: tick.bid, ask: tick.ask, time: tick.time } : null,
        spec: spec.status === 200 ? SymbolSpecSchema.parse(spec.json) : null,
        positions: pos.status === 200 ? z.array(BrokerPositionSchema).parse(pos.json.positions) : [],
        orders: ord.status === 200 ? z.array(BrokerOrderSchema).parse(ord.json.orders) : [],
      };
    },
    async deals(since) {
      const r = await bridge.http('GET', `/deals?since=${encodeURIComponent(String(since))}`);
      if (r.status !== 200) throw new Error(r.json?.error ?? 'MT5 deal history unavailable');
      return z.array(BrokerDealSchema).parse(r.json.deals);
    },
    async execute(action, body) {
      const r = await bridge.http('POST', `/trade/${action}`, body, 45_000);
      if (r.status !== 200) throw new BrokerNotSent(String(r.json?.error ?? `Bridge refused (HTTP ${r.status})`), String(r.json?.code ?? 'bridge'));
      return BrokerOutcomeSchema.parse(r.json);
    },
    async find(commandId, ticket) {
      const q = `commandId=${encodeURIComponent(commandId)}${ticket ? `&ticket=${ticket}` : ''}`;
      const r = await bridge.http('GET', `/trade/find?${q}`);
      if (r.status !== 200) throw new Error(r.json?.error ?? 'MT5 lookup failed');
      return EvidenceSchema.parse(r.json);
    },
  };
}

export interface OrdersState {
  enabled: boolean;
  killSwitch: boolean;
  account: { demo: boolean; currency: string; balance: number; server?: string; login?: number | null } | null;
  spec: { volumeStep: number; volumeMin: number } | null;
  positions: z.infer<typeof BrokerPositionSchema>[];
  orders: z.infer<typeof BrokerOrderSchema>[];
  error: string | null;
}

export class OrderService {
  readonly engine: OrderEngine;
  /** Ids of trade plans the user approved; supplied by the Trade Assistant so the risk gate can check them. */
  approvedPlanIds: () => string[] = () => [];
  snapshot() { return bridgePort(this.bridge).snapshot(); }
  constructor(private readonly bridge: BridgeManager, private readonly getConfig: () => AppConfig, private readonly db: () => DatabaseSync) {
    this.engine = new OrderEngine({
      broker: bridgePort(bridge),
      settings: () => {
        const c = this.getConfig();
        return { tradingEnabled: c.trading.enabled, risk: c.risk, aiPermissions: c.aiPermissions, allowedSymbols: [c.brokerSymbol], pipSize: c.pipSize, assistant: { enabled: c.assistant.enabled, approvedPlanIds: this.approvedPlanIds() } };
      },
      onRecord: (r) => this.saveRecord(r),
      onActivity: (a) => this.saveActivity(a),
    });
    try { this.engine.restore(this.loadRecords()); } catch { /* a corrupt history must not block startup */ }
  }

  private loadRecords(): OrderRecord[] {
    const rows = this.db().prepare('SELECT json FROM order_records WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 500').all(WORKSPACE) as { json: string }[];
    return rows.flatMap((r) => { try { return [JSON.parse(r.json) as OrderRecord]; } catch { return []; } });
  }
  private saveRecord(r: OrderRecord): void {
    this.db().prepare('INSERT INTO order_records (command_id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(command_id, workspace_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(r.commandId, WORKSPACE, JSON.stringify(r), r.updatedAt);
  }
  private saveActivity(a: ActivityEntry): void {
    this.db().prepare('INSERT INTO order_activity (workspace_id, at, json) VALUES (?, ?, ?)').run(WORKSPACE, a.at, JSON.stringify(a));
  }
  activity(limit = 100): ActivityEntry[] {
    const rows = this.db().prepare('SELECT json FROM order_activity WHERE workspace_id = ? ORDER BY id DESC LIMIT ?').all(WORKSPACE, limit) as { json: string }[];
    return rows.flatMap((r) => { try { return [JSON.parse(r.json) as ActivityEntry]; } catch { return []; } });
  }

  /** The pre-trade checklist as the user saw it when confirming (items that did not pass + what they ticked). */
  saveCheck(commandId: string, snapshot: unknown): void {
    const json = JSON.stringify(snapshot);
    if (json.length > 20_000) throw new Error('Checklist snapshot too large.');
    this.db().prepare('INSERT INTO trade_checks (command_id, workspace_id, json, at) VALUES (?, ?, ?, ?) ON CONFLICT(command_id, workspace_id) DO UPDATE SET json = excluded.json, at = excluded.at')
      .run(commandId, WORKSPACE, json, Date.now());
  }

  /** Saved checklists joined to the MT5 position they produced (position ticket from the confirmed order record). */
  checks(): { commandId: string; positionId: number | null; snapshot: unknown; at: number }[] {
    const rows = this.db().prepare('SELECT c.command_id AS id, c.json AS json, c.at AS at, r.json AS rec FROM trade_checks c LEFT JOIN order_records r ON r.command_id = c.command_id AND r.workspace_id = c.workspace_id WHERE c.workspace_id = ? ORDER BY c.at DESC LIMIT 500')
      .all(WORKSPACE) as { id: string; json: string; at: number; rec: string | null }[];
    return rows.flatMap((r) => {
      try {
        const rec = r.rec ? (JSON.parse(r.rec) as OrderRecord) : null;
        return [{ commandId: r.id, positionId: rec?.broker?.positionTicket ?? null, snapshot: JSON.parse(r.json) as unknown, at: r.at }];
      } catch { return []; }
    });
  }

  /** Closed-deal history from MT5 (the EA returns at most the newest 500 deals). */
  async history(days: number): Promise<BrokerDeal[]> {
    const since = Math.floor(Date.now() / 1000) - Math.max(1, Math.min(365, Math.round(days))) * 86400;
    return bridgePort(this.bridge).deals(since);
  }

  async state(): Promise<OrdersState> {
    const c = this.getConfig();
    const base = { enabled: c.trading.enabled, killSwitch: this.engine.killSwitch };
    try {
      const st = await bridgePort(this.bridge).snapshot();
      return { ...base, account: st.account && { demo: st.account.demo, currency: st.account.currency, balance: st.account.balance, server: st.account.server, login: st.account.login }, spec: st.spec && { volumeStep: st.spec.volumeStep, volumeMin: st.spec.volumeMin }, positions: st.positions, orders: st.orders, error: null };
    } catch (e) {
      return { ...base, account: null, spec: null, positions: [], orders: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
}
