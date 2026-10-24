import { z } from 'zod';
import type { AiTool, ToolResult } from './aiTools';
import { lotsForRisk } from './risk';
import { partialCloseVolume } from './orders';
import { PendingTypeSchema, stampCommand, type AnyOrderCommand, type BrokerPosition } from './orderCommand';
import type { PrepareResult } from './orderEngine';

/**
 * propose_order_action: the ONLY order-related tool the AI has. It creates a PREVIEW (a prepared command held by the
 * app) and returns its id. It never executes anything. Execution needs the user to press Confirm in the UI, and then
 * the RiskGate runs again with fresh broker data (AI-origin commands also need orders mode "confirm" + the specific
 * permission, and are blocked by "Stop AI actions").
 */
export interface OrdersPort {
  orderMode: 'suggest' | 'confirm' | 'automatic';
  maxRiskPerTradePct: number;
  /** Broker symbol the app trades (the only one that can pass the gate). */
  symbol: string;
  positions(): Promise<BrokerPosition[]>;
  /** Prepare (preview + dry gate). Holds the command in the app until the user confirms or it expires. */
  propose(cmd: AnyOrderCommand): Promise<PrepareResult>;
}

const Price = z.number().positive();
const Reason = z.string().min(3).max(300).describe('Why, in one or two sentences. Shown to the user.');
const Ticket = z.number().int().positive();

const ProposalInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open_market'), side: z.enum(['buy', 'sell']), sl: Price, tp: Price.optional(), volume: z.number().positive().optional(), riskPct: z.number().positive().max(100).optional(), reason: Reason }),
  z.object({ action: z.literal('open_pending'), orderType: PendingTypeSchema, price: Price, sl: Price, tp: Price.optional(), volume: z.number().positive().optional(), riskPct: z.number().positive().max(100).optional(), reason: Reason }),
  z.object({ action: z.literal('modify_sltp'), ticket: Ticket, ticketKind: z.enum(['position', 'order']).optional(), sl: Price.nullable().optional(), tp: Price.nullable().optional(), reason: Reason }),
  z.object({ action: z.literal('close_position'), ticket: Ticket, reason: Reason }),
  z.object({ action: z.literal('partial_close'), ticket: Ticket, percent: z.number().gt(0).lt(100).describe('Percent of the position to close; the app rounds DOWN to the broker volume step.'), reason: Reason }),
  z.object({ action: z.literal('cancel_pending'), ticket: Ticket, reason: Reason }),
  z.object({ action: z.literal('close_all'), reason: Reason }),
]);
type Proposal = z.infer<typeof ProposalInput>;

const fail = (code: Extract<ToolResult, { ok: false }>['code'], error: string): ToolResult => ({ ok: false, code, error });

export const ORDER_TOOLS: AiTool[] = [
  {
    name: 'propose_order_action',
    description:
      'Prepare a PREVIEW of an order action for the user: open_market, open_pending, modify_sltp, close_position, partial_close, cancel_pending or close_all. ' +
      'This NEVER places or changes anything. The user sees a preview card and must press Confirm; the deterministic risk gate decides again at that moment. ' +
      'Lot size: give riskPct and the app computes the lots with code (or give volume). After calling, tell the user a preview is waiting for their confirmation. ' +
      'NEVER say an order was placed, modified or closed: only the broker result shown in the app counts.',
    input: ProposalInput,
    needs: (p) => p.chartRead,
    needsLabel: 'Chart read',
    async run(ctx, input: Proposal): Promise<ToolResult> {
      const port = ctx.orders;
      if (!port) return fail('unavailable', 'Order previews are not available in this session.');
      const now = ctx.now?.() ?? Date.now();
      const base = { symbol: port.symbol, reason: input.reason };
      let body: { type: string; [k: string]: unknown };
      if (input.action === 'open_market' || input.action === 'open_pending') {
        const st = ctx.getState();
        const spec = ctx.getSpec();
        const side = input.action === 'open_market' ? input.side : input.orderType.startsWith('buy') ? 'buy' : 'sell';
        const entry = input.action === 'open_pending' ? input.price : side === 'buy' ? st.ask : st.bid;
        let volume = input.volume;
        const riskPct = Math.min(input.riskPct ?? 0.5, port.maxRiskPerTradePct);
        if (volume === undefined) {
          const balance = st.account?.balance;
          if (!spec || !balance || entry === null || entry === undefined) return fail('unavailable', 'Cannot size the order: needs a live quote, the account balance and the contract spec from MT5.');
          const sized = lotsForRisk({ balance, riskPct, slDistance: Math.abs(entry - input.sl), spec });
          if (sized.blocked || sized.lots <= 0) return fail('invalid_input', `Cannot size ${riskPct}% risk with this stop: ${sized.blocked ?? 'no valid lot size'}.`);
          volume = sized.lots;
        }
        body = input.action === 'open_market'
          ? { type: 'open_market', ...base, side: input.side, volume, sl: input.sl, tp: input.tp ?? null, deviationPoints: 20, riskPct }
          : { type: 'open_pending', ...base, orderType: input.orderType, price: input.price, volume, sl: input.sl, tp: input.tp ?? null, riskPct };
      } else if (input.action === 'modify_sltp') {
        if (input.sl === undefined && input.tp === undefined) return fail('invalid_input', 'Give a new sl and/or tp.');
        body = { type: 'modify_sltp', ...base, ticket: input.ticket, ticketKind: input.ticketKind ?? 'position', ...(input.sl !== undefined ? { sl: input.sl } : {}), ...(input.tp !== undefined ? { tp: input.tp } : {}) };
      } else if (input.action === 'partial_close') {
        const spec = ctx.getSpec();
        const pos = (await port.positions()).find((p) => p.ticket === input.ticket);
        if (!pos) return fail('invalid_input', `Position #${input.ticket} is not open.`);
        if (!spec) return fail('unavailable', 'The contract spec is not available yet.');
        const vol = partialCloseVolume(pos.volume, input.percent / 100, spec);
        if (vol === null) return fail('invalid_input', `${input.percent}% of ${pos.volume} lot cannot be closed on this broker's volume step while leaving a valid remainder.`);
        body = { type: 'partial_close', ...base, ticket: input.ticket, volume: vol };
      } else if (input.action === 'close_position' || input.action === 'cancel_pending') {
        body = { type: input.action, ...base, ticket: input.ticket };
      } else {
        body = { type: 'close_all', ...base };
      }
      const cmd = stampCommand(body, { actor: 'ai', symbol: port.symbol, now, commandId: ctx.newId?.() });
      const res = await port.propose(cmd as unknown as AnyOrderCommand);
      if (!res.ok) return fail('invalid_input', res.error);
      if (res.existing) return fail('rejected', 'That command id was already used.');
      const blocked = res.gate.failed;
      return {
        ok: true,
        data: {
          proposed: true, commandId: res.commandId, title: res.preview.title, executable: res.executable,
          blockedBy: blocked ? { rule: blocked.rule, message: blocked.message } : null,
          orderMode: port.orderMode,
          next: res.executable
            ? 'A PREVIEW card is shown to the user. NOTHING has been sent. The user must press Confirm in the app; the risk gate will run again then. Do not claim it is executed.'
            : `A PREVIEW card is shown but it cannot be executed now (${blocked?.rule}). NOTHING has been sent. Tell the user plainly why.`,
          expiresInSec: Math.max(0, Math.round((res.expiresAt - now) / 1000)),
        },
      };
    },
  },
];
