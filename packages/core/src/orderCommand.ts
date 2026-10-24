import { z } from 'zod';
import type { ContractSpec } from './risk';
import { riskAtSl } from './orders';

/**
 * Order command pipeline types. Everything that can move real money travels as one of these, is validated by Zod,
 * carries an idempotency key (`commandId`), an actor and an expiry, and is turned into a human-readable PREVIEW
 * before anything is sent. Nothing in this file talks to a broker.
 */

export const OrderActorSchema = z.enum(['manual', 'ai', 'whatsapp']);
export type OrderActor = z.infer<typeof OrderActorSchema>;

/** Trade commands expire fast: a stale confirm must never fire later. */
export const ORDER_COMMAND_TTL_MS = 120_000;

const Price = z.number().positive().finite();
const Volume = z.number().positive().finite();
const Ticket = z.number().int().positive();

const envelope = {
  /** Idempotency key. 8-80 chars, matches the bridge limit. */
  commandId: z.string().min(8).max(80).regex(/^[A-Za-z0-9._:-]+$/, 'commandId may only contain letters, digits and . _ : -'),
  actor: OrderActorSchema,
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  /** Broker symbol. Must pass the GOLD-only allow-list in the RiskGate. */
  symbol: z.string().min(1).max(32),
  reason: z.string().max(300).optional(),
};

export const PendingTypeSchema = z.enum(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop']);
export type PendingType = z.infer<typeof PendingTypeSchema>;

/** Planned (NOT placed) take-profit ladder, kept with the order for the preview and the journal. */
const PlannedTpSchema = z.object({ price: Price, closePct: z.number().min(0).max(100) });

export const OpenMarketSchema = z.object({
  ...envelope,
  type: z.literal('open_market'),
  side: z.enum(['buy', 'sell']),
  volume: Volume,
  sl: Price.nullable(),
  tp: Price.nullable(),
  deviationPoints: z.number().int().min(0).max(100).default(20),
  /** Risk the sizing aimed for, kept for the risk snapshot. */
  riskPct: z.number().positive().max(100).optional(),
  plannedTps: z.array(PlannedTpSchema).max(5).optional(),
});

export const OpenPendingSchema = z.object({
  ...envelope,
  type: z.literal('open_pending'),
  orderType: PendingTypeSchema,
  price: Price,
  volume: Volume,
  sl: Price.nullable(),
  tp: Price.nullable(),
  expiration: z.number().int().positive().optional(),
  riskPct: z.number().positive().max(100).optional(),
  plannedTps: z.array(PlannedTpSchema).max(5).optional(),
});

export const ModifySltpSchema = z
  .object({
    ...envelope,
    type: z.literal('modify_sltp'),
    ticket: Ticket,
    ticketKind: z.enum(['position', 'order']).default('position'),
    /** Absent = keep the current value. null = remove it. */
    sl: Price.nullable().optional(),
    tp: Price.nullable().optional(),
  })
  .refine((c) => c.sl !== undefined || c.tp !== undefined, { message: 'Give a new sl and/or tp.' });

export const ClosePositionSchema = z.object({ ...envelope, type: z.literal('close_position'), ticket: Ticket });
export const PartialCloseSchema = z.object({ ...envelope, type: z.literal('partial_close'), ticket: Ticket, volume: Volume });
export const CancelPendingSchema = z.object({ ...envelope, type: z.literal('cancel_pending'), ticket: Ticket });

/** Bulk close is a SEPARATE command with its own permission; it expands into per-position closes. */
export const CloseAllSchema = z.object({ ...envelope, type: z.literal('close_all') });

export const AnyOrderCommandSchema = z.discriminatedUnion('type', [
  OpenMarketSchema, OpenPendingSchema, ModifySltpSchema, ClosePositionSchema, PartialCloseSchema, CancelPendingSchema, CloseAllSchema,
]);
/** Full validation (incl. the modify refinement). */
export const parseOrderCommand = (raw: unknown) => AnyOrderCommandSchema.safeParse(raw);

export type OpenMarketCommand = z.infer<typeof OpenMarketSchema>;
export type OpenPendingCommand = z.infer<typeof OpenPendingSchema>;
export type ModifySltpCommand = z.infer<typeof ModifySltpSchema>;
export type ClosePositionCommand = z.infer<typeof ClosePositionSchema>;
export type PartialCloseCommand = z.infer<typeof PartialCloseSchema>;
export type CancelPendingCommand = z.infer<typeof CancelPendingSchema>;
export type CloseAllCommand = z.infer<typeof CloseAllSchema>;
export type OrderCommand = OpenMarketCommand | OpenPendingCommand | ModifySltpCommand | ClosePositionCommand | PartialCloseCommand | CancelPendingCommand;
export type AnyOrderCommand = OrderCommand | CloseAllCommand;
export type OrderCommandType = AnyOrderCommand['type'];

export const OPENING_TYPES: readonly OrderCommandType[] = ['open_market', 'open_pending'];
export const isOpening = (c: Pick<AnyOrderCommand, 'type'>) => OPENING_TYPES.includes(c.type);

/** Command input as callers supply it: the envelope fields besides `symbol` and `actor` are filled by `stampCommand`. */
export type CommandBody<T extends AnyOrderCommand = AnyOrderCommand> = T extends unknown
  ? Omit<T, 'commandId' | 'actor' | 'createdAt' | 'expiresAt' | 'symbol'> & { symbol?: string }
  : never;

export function newCommandId(prefix = 'ord'): string {
  const rand = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2).padEnd(24, '0');
  return `${prefix}-${rand.slice(0, 24)}`;
}

/** Fill in the envelope. The only place commands get their id / actor / expiry, for UI and AI alike. */
export function stampCommand<B extends { type: string }>(body: B, o: { actor: OrderActor; symbol: string; now?: number; ttlMs?: number; commandId?: string }): B & { commandId: string; actor: OrderActor; createdAt: number; expiresAt: number; symbol: string } {
  const now = o.now ?? Date.now();
  return { ...body, symbol: (body as { symbol?: string }).symbol ?? o.symbol, commandId: o.commandId ?? newCommandId(), actor: o.actor, createdAt: now, expiresAt: now + (o.ttlMs ?? ORDER_COMMAND_TTL_MS) };
}

/** Stable fingerprint of what a command DOES (envelope timing excluded), to detect a reused commandId with a different payload. */
export function commandFingerprint(c: AnyOrderCommand): string {
  const { createdAt: _c, expiresAt: _e, reason: _r, ...rest } = c as Record<string, unknown>;
  const keys = Object.keys(rest).sort();
  return keys.map((k) => `${k}=${JSON.stringify(rest[k] ?? null)}`).join('|');
}

// ---------------------------------------------------------------------------------------------------------
// Broker payloads (what the bridge answers). Validated at the process boundary.

export const BrokerPositionSchema = z.object({
  ticket: z.number().int(), time: z.number(), type: z.enum(['buy', 'sell']), volume: z.number(), priceOpen: z.number(),
  sl: z.number().nullable(), tp: z.number().nullable(), priceCurrent: z.number(), swap: z.number(), profit: z.number(),
  symbol: z.string(), magic: z.number(), comment: z.string(),
});
export type BrokerPosition = z.infer<typeof BrokerPositionSchema>;

export const BrokerOrderSchema = z.object({
  ticket: z.number().int(), time: z.number(), type: z.string(), volume: z.number(), priceOpen: z.number(),
  sl: z.number().nullable(), tp: z.number().nullable(), priceCurrent: z.number(), state: z.number(), symbol: z.string(),
  magic: z.number(), comment: z.string(), expiration: z.number().nullable(), positionId: z.number().nullable(),
});
export type BrokerOrder = z.infer<typeof BrokerOrderSchema>;

export const BrokerDealSchema = z.object({
  ticket: z.number().int(), order: z.number(), time: z.number(), type: z.string(), entry: z.string(), positionId: z.number(),
  volume: z.number(), price: z.number(), commission: z.number(), swap: z.number(), profit: z.number(), fee: z.number(),
  reason: z.string(), symbol: z.string(), magic: z.number(), comment: z.string(),
});
export type BrokerDeal = z.infer<typeof BrokerDealSchema>;

/** The 200 answer of a trade endpoint. */
export const BrokerOutcomeSchema = z.object({
  status: z.enum(['done', 'partial', 'rejected', 'unknown']),
  stage: z.string().optional(),
  retcode: z.number().nullable().optional(),
  retcodeName: z.string().optional(),
  message: z.string().optional(),
  brokerComment: z.string().nullable().optional(),
  order: z.number().nullable().optional(),
  deal: z.number().nullable().optional(),
  positionTicket: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  duplicate: z.boolean().optional(),
}).passthrough();
export type BrokerOutcome = z.infer<typeof BrokerOutcomeSchema>;

export const EvidenceSchema = z.object({
  tag: z.string(),
  queried: z.object({ positions: z.boolean(), orders: z.boolean(), deals: z.boolean(), historyOrders: z.boolean() }),
  positions: z.array(BrokerPositionSchema),
  orders: z.array(BrokerOrderSchema),
  deals: z.array(BrokerDealSchema),
  historyOrders: z.array(BrokerOrderSchema),
  target: z.object({
    ticket: z.number(),
    position: BrokerPositionSchema.nullable(),
    order: BrokerOrderSchema.nullable(),
    deals: z.array(BrokerDealSchema),
  }).nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ---------------------------------------------------------------------------------------------------------
// Preview

export interface PreviewContext {
  currency: string;
  demo: boolean | null;
  pipSize: number;
  spec: ContractSpec | null;
  bid: number | null;
  ask: number | null;
  balance: number | null;
  positions: BrokerPosition[];
  orders?: { ticket: number; type: string; volume: number; priceOpen: number }[];
}

export interface OrderPreview {
  /** Short title, e.g. "BUY 0.10 lot GOLD at market". */
  title: string;
  /** One fact per line, in plain words. */
  lines: string[];
  /** Closing, cancelling or widening-risk actions use warning wording in the UI. */
  destructive: boolean;
  /** Money at risk by this command after it is done (opening or SL change); null when not applicable. */
  riskMoney: number | null;
  riskPct: number | null;
  /** The whole preview as one string (chat card, WhatsApp, activity log). */
  text: string;
}

const money = (v: number, cur: string) => `${v.toFixed(2)} ${cur}`;
const px = (v: number | null | undefined) => (v === null || v === undefined ? 'none' : v.toFixed(2));

function slLine(side: 'buy' | 'sell', entry: number, sl: number | null, tp: number | null, pip: number): string[] {
  const out: string[] = [];
  out.push(sl === null ? 'Stop loss: NONE (this position would have unlimited risk)' : `Stop loss ${px(sl)} (${Math.abs(entry - sl).toFixed(2)} price = ${(Math.abs(entry - sl) / pip).toFixed(0)} pips from entry)`);
  out.push(tp === null ? 'Take profit: none' : `Take profit ${px(tp)} (${Math.abs(tp - entry).toFixed(2)} price = ${(Math.abs(tp - entry) / pip).toFixed(0)} pips from entry)`);
  void side;
  return out;
}

export function previewCommand(cmd: AnyOrderCommand, ctx: PreviewContext): OrderPreview {
  const acct = ctx.demo === null ? 'account unknown' : ctx.demo ? 'DEMO account' : 'LIVE account';
  const sym = cmd.symbol;
  const finish = (title: string, lines: string[], destructive: boolean, riskMoney: number | null = null): OrderPreview => {
    const riskPct = riskMoney !== null && ctx.balance ? (riskMoney / ctx.balance) * 100 : null;
    const all = [...lines, `Account: ${acct}. Actor: ${cmd.actor}. Command ${cmd.commandId}.`];
    return { title, lines: all, destructive, riskMoney, riskPct, text: `${title}\n${all.map((l) => `- ${l}`).join('\n')}` };
  };
  const riskOf = (side: 'buy' | 'sell', entry: number, sl: number | null, vol: number) => (ctx.spec ? riskAtSl(ctx.spec, side, entry, sl, vol) : null);
  const posOf = (t: number) => ctx.positions.find((p) => p.ticket === t);

  switch (cmd.type) {
    case 'open_market': {
      const entry = cmd.side === 'buy' ? ctx.ask : ctx.bid;
      const risk = entry === null ? null : riskOf(cmd.side, entry, cmd.sl, cmd.volume);
      const lines = [
        `Opens a NEW ${cmd.side.toUpperCase()} position of ${cmd.volume} lot at the current market price${entry !== null ? ` (about ${px(entry)})` : ''}.`,
        ...(entry !== null ? slLine(cmd.side, entry, cmd.sl, cmd.tp, ctx.pipSize) : [`Stop loss ${px(cmd.sl)}, take profit ${px(cmd.tp)}`]),
        `Allowed slippage: ${cmd.deviationPoints} points.`,
      ];
      if (risk !== null) lines.push(Number.isFinite(risk) ? `Money at risk if the stop is hit: ${money(risk, ctx.currency)}${ctx.balance ? ` (${((risk / ctx.balance) * 100).toFixed(2)}% of balance)` : ''}` : 'Money at risk: UNLIMITED (no stop loss)');
      if (cmd.plannedTps?.length) lines.push(`Planned only, NOT placed now: ${cmd.plannedTps.map((t, i) => `TP${i + 1} ${px(t.price)} close ${t.closePct}%`).join('; ')}. Nothing closes these parts automatically.`);
      return finish(`${cmd.side.toUpperCase()} ${cmd.volume} lot ${sym} at market`, lines, false, risk !== null && Number.isFinite(risk) ? risk : null);
    }
    case 'open_pending': {
      const side = cmd.orderType.startsWith('buy') ? 'buy' : 'sell';
      const risk = riskOf(side, cmd.price, cmd.sl, cmd.volume);
      const lines = [
        `Places a PENDING ${cmd.orderType.replace('_', ' ').toUpperCase()} order of ${cmd.volume} lot at ${px(cmd.price)}. It only opens a position if price reaches that level.`,
        ...slLine(side, cmd.price, cmd.sl, cmd.tp, ctx.pipSize),
      ];
      if (cmd.expiration) lines.push(`Expires at broker time ${new Date(cmd.expiration * 1000).toISOString().replace('T', ' ').slice(0, 16)}.`);
      if (risk !== null) lines.push(Number.isFinite(risk) ? `Money at risk if filled and the stop is hit: ${money(risk, ctx.currency)}${ctx.balance ? ` (${((risk / ctx.balance) * 100).toFixed(2)}% of balance)` : ''}` : 'Money at risk: UNLIMITED (no stop loss)');
      if (cmd.plannedTps?.length) lines.push(`Planned only, NOT placed now: ${cmd.plannedTps.map((t, i) => `TP${i + 1} ${px(t.price)} close ${t.closePct}%`).join('; ')}.`);
      return finish(`${cmd.orderType.replace('_', ' ').toUpperCase()} ${cmd.volume} lot ${sym} @ ${px(cmd.price)}`, lines, false, risk !== null && Number.isFinite(risk) ? risk : null);
    }
    case 'modify_sltp': {
      const p = cmd.ticketKind === 'position' ? posOf(cmd.ticket) : undefined;
      const lines = [`Changes protection on ${cmd.ticketKind === 'position' ? 'position' : 'pending order'} #${cmd.ticket}${p ? ` (${p.type.toUpperCase()} ${p.volume} lot, opened ${px(p.priceOpen)})` : ''}.`];
      let risk: number | null = null;
      let widens = false;
      if (cmd.sl !== undefined) lines.push(`Stop loss: ${p ? px(p.sl) : '?'} -> ${cmd.sl === null ? 'REMOVED' : px(cmd.sl)}`);
      if (cmd.tp !== undefined) lines.push(`Take profit: ${p ? px(p.tp) : '?'} -> ${cmd.tp === null ? 'REMOVED' : px(cmd.tp)}`);
      if (p && cmd.sl !== undefined && ctx.spec) {
        const before = riskAtSl(ctx.spec, p.type, p.priceOpen, p.sl, p.volume);
        const after = riskAtSl(ctx.spec, p.type, p.priceOpen, cmd.sl, p.volume);
        risk = Number.isFinite(after) ? after : null;
        widens = after > before + 1e-9;
        lines.push(widens ? 'WARNING: this moves the stop further away, so the position risks MORE money.' : 'This does not increase the money at risk.');
        if (risk !== null) lines.push(`Money at risk at the new stop (measured from the open price): ${money(risk, ctx.currency)}`);
      }
      return finish(`Modify SL/TP of #${cmd.ticket}`, lines, widens || cmd.sl === null, risk);
    }
    case 'close_position': {
      const p = posOf(cmd.ticket);
      const lines = [`CLOSES position #${cmd.ticket} completely at the current market price.`];
      if (p) lines.push(`${p.type.toUpperCase()} ${p.volume} lot, opened ${px(p.priceOpen)}, floating P/L now ${money(p.profit, ctx.currency)} (it becomes realised).`);
      return finish(`Close position #${cmd.ticket}`, lines, true);
    }
    case 'partial_close': {
      const p = posOf(cmd.ticket);
      const lines = [`CLOSES ${cmd.volume} lot of position #${cmd.ticket} at the current market price.`];
      if (p) lines.push(`Position ${p.volume} lot -> ${(Math.round((p.volume - cmd.volume) * 1e8) / 1e8).toString()} lot remains open (${((cmd.volume / p.volume) * 100).toFixed(0)}% closed). Floating P/L of the whole position now ${money(p.profit, ctx.currency)}.`);
      return finish(`Partial close ${cmd.volume} lot of #${cmd.ticket}`, lines, true);
    }
    case 'cancel_pending': {
      const o = ctx.orders?.find((x) => x.ticket === cmd.ticket);
      return finish(`Cancel pending order #${cmd.ticket}`, [`CANCELS pending order #${cmd.ticket}${o ? ` (${o.type.replace('_', ' ')} ${o.volume} lot @ ${px(o.priceOpen)})` : ''}. No position is opened or closed.`], true);
    }
    case 'close_all': {
      const total = ctx.positions.reduce((s, p) => s + p.profit, 0);
      const lines = [
        `CLOSES ALL ${ctx.positions.length} open position(s) on ${sym} at market, one after another.`,
        ...ctx.positions.map((p) => `#${p.ticket} ${p.type.toUpperCase()} ${p.volume} lot, P/L ${money(p.profit, ctx.currency)}`),
        `Total floating P/L that becomes realised: ${money(total, ctx.currency)}. Pending orders are not touched.`,
      ];
      return finish(`CLOSE ALL positions on ${sym}`, lines, true);
    }
  }
}
