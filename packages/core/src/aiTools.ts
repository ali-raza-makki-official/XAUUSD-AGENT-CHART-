import { z } from 'zod';
import { type AiPermissions } from './settings';
import { DrawingStore, type DrawingOp } from './drawingStore';
import { DrawingSchema, makeDrawing, positionIssues, rewardRisk, type Drawing } from './drawing';
import { lotsForRisk, priceToPips, type ContractSpec } from './risk';
import { TimeframeSchema, type Candle, type Timeframe } from './feed';
import { AlertConditionSchema, ChannelsSchema, RepeatSchema, SeveritySchema, makeAlert, referenceIssue, type AlertCondition, type Channels, type Repeat } from './alerts';
import { type AlertCommand, type AlertDispatchResult } from './alertStore';
import { type AlertsSnapshot } from './alertMonitor';

/**
 * The only way the AI touches the app. Every tool validates its input with Zod, checks the capability
 * matrix, and goes through the same DrawingStore as manual edits (locks, layers, undo, duplicate protection).
 */

/** Chart time is the broker server clock (same as MT5), as unix seconds or an ISO-8601 string. */
const TimeInput = z.union([z.number(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'number') return v;
  const ms = Date.parse(v.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  if (Number.isNaN(ms)) { ctx.addIssue({ code: 'custom', message: `Invalid time: ${v}` }); return z.NEVER; }
  return Math.floor(ms / 1000);
});
const Pt = z.object({ time: TimeInput, price: z.number().positive() });
const Reason = z.string().min(3).max(500).describe('Short explanation shown to the user for why this drawing exists.');
const Common = {
  label: z.string().max(80).optional(),
  note: z.string().max(1000).optional(),
  timeframes: z.union([z.literal('all'), z.array(TimeframeSchema)]).optional().describe("Timeframes to show on; default 'all'."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  reason: Reason,
};

const NewDrawing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hline'), price: z.number().positive(), ...Common }),
  z.object({ kind: z.literal('vline'), time: TimeInput, ...Common }),
  z.object({ kind: z.literal('ray'), a: Pt, b: Pt, ...Common }),
  z.object({ kind: z.literal('trendline'), a: Pt, b: Pt, extend: z.enum(['none', 'right', 'both']).optional(), ...Common }),
  z.object({ kind: z.literal('channel'), a: Pt, b: Pt, c: Pt, ...Common }),
  z.object({ kind: z.literal('zone'), a: Pt, b: Pt, zoneType: z.enum(['support', 'resistance', 'supply', 'demand', 'custom']).optional(), extendRight: z.boolean().optional(), ...Common }),
  z.object({ kind: z.literal('fib'), a: Pt, b: Pt, ...Common }),
  z.object({ kind: z.literal('measure'), a: Pt, b: Pt, ...Common }),
  z.object({ kind: z.literal('text'), at: Pt, text: z.string().min(1).max(500), ...Common }),
  z.object({
    kind: z.literal('position'),
    side: z.enum(['buy', 'sell']),
    entryTime: TimeInput,
    entry: z.number().positive(),
    stopLoss: z.number().positive(),
    takeProfits: z.array(z.object({ price: z.number().positive(), closePct: z.number().min(0).max(100) })).max(5),
    riskPct: z.number().positive().max(100).optional(),
    ...Common,
  }),
]);
type NewDrawingInput = z.infer<typeof NewDrawing>;

const Patchable = z.object({
  label: z.string().max(80).optional(),
  note: z.string().max(1000).optional(),
  visible: z.boolean().optional(),
  showLabel: z.boolean().optional(),
  timeframes: z.union([z.literal('all'), z.array(TimeframeSchema)]).optional(),
  style: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), width: z.number().min(1).max(8), lineStyle: z.enum(['solid', 'dashed', 'dotted']), fillOpacity: z.number().min(0).max(1) }).partial().optional(),
  price: z.number().positive().optional(),
  time: TimeInput.optional(),
  a: Pt.optional(), b: Pt.optional(), c: Pt.optional(), at: Pt.optional(),
  text: z.string().max(500).optional(),
  zoneType: z.enum(['support', 'resistance', 'supply', 'demand', 'custom']).optional(),
  extendRight: z.boolean().optional(),
  extend: z.enum(['none', 'right', 'both']).optional(),
  side: z.enum(['buy', 'sell']).optional(),
  entry: z.number().positive().optional(),
  entryTime: TimeInput.optional(),
  stopLoss: z.number().positive().optional(),
  takeProfits: z.array(z.object({ price: z.number().positive(), closePct: z.number().min(0).max(100) })).max(5).optional(),
  riskPct: z.number().positive().max(100).optional(),
}).strict();

export interface ChartState {
  symbol: string;
  brokerSymbol: string;
  timeframe: Timeframe;
  feed: string;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  /** Broker clock of the last tick (unix s). */
  tickTime: number | null;
  account: { demo: boolean; currency: string; balance?: number; equity?: number } | null;
  selectedDrawingId: string | null;
  pipSize: number;
}

export interface ToolContext {
  store: DrawingStore;
  permissions: AiPermissions;
  getState(): ChartState;
  getCandles(tf: Timeframe, count: number): Promise<Candle[]>;
  getSpec(): ContractSpec | null;
  /** Alert storage + fire history. The same AlertStore command path the manual UI uses (in the desktop app it lives in the main process). */
  alerts?: AlertsPort;
  /** Whether balance/equity and money amounts may be returned to the AI provider. Off by default. */
  exposeBalance?: boolean;
  /** Start of "today" for the undo-all-AI-changes-today tool. */
  startOfToday(): number;
  newId?: () => string;
  now?: () => number;
}

export interface AlertsPort {
  snapshot(): Promise<AlertsSnapshot> | AlertsSnapshot;
  dispatch(cmd: AlertCommand): Promise<AlertDispatchResult> | AlertDispatchResult;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; code: 'permission_denied' | 'invalid_input' | 'rejected' | 'unavailable'; error: string };
const fail = (code: Extract<ToolResult, { ok: false }>['code'], error: string): ToolResult => ({ ok: false, code, error });

export interface AiTool {
  name: string;
  description: string;
  input: z.ZodType;
  /** Capability needed; null = always allowed. */
  needs: ((p: AiPermissions) => boolean) | null;
  needsLabel: string;
  run(ctx: ToolContext, input: never): Promise<ToolResult> | ToolResult;
}

const SANE_BAND = 0.25;
function priceSanity(ctx: ToolContext, prices: number[]): string | null {
  const ref = ctx.getState().bid;
  if (!ref) return null;
  const bad = prices.find((p) => Math.abs(p - ref) / ref > SANE_BAND);
  return bad === undefined ? null : `Price ${bad} is more than ${SANE_BAND * 100}% away from the current price ${ref}; refusing a likely mistake.`;
}

function pricesOf(d: NewDrawingInput): number[] {
  switch (d.kind) {
    case 'hline': return [d.price];
    case 'vline': return [];
    case 'text': return [d.at.price];
    case 'channel': return [d.a.price, d.b.price, d.c.price];
    case 'position': return [d.entry, d.stopLoss, ...d.takeProfits.map((t) => t.price)];
    default: return [d.a.price, d.b.price];
  }
}

function toDrawing(ctx: ToolContext, d: NewDrawingInput, commandId: string): Drawing {
  const { reason, label, note, timeframes, color, kind, ...geo } = d as NewDrawingInput & Record<string, unknown>;
  const geometry = Object.fromEntries(Object.entries(geo).filter(([, v]) => v !== undefined));
  return makeDrawing({ kind, ...geometry } as never, {
    id: ctx.newId?.() ?? globalThis.crypto.randomUUID(), actor: 'ai', now: ctx.now?.() ?? Date.now(), commandId,
    reason, label, note, timeframes, style: color ? { color } : undefined,
  });
}

const cid = (ctx: ToolContext) => ctx.newId?.() ?? globalThis.crypto.randomUUID();

const AiAlertPatch = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  condition: AlertConditionSchema,
  repeat: RepeatSchema,
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  channels: ChannelsSchema,
  message: z.string().max(500),
  severity: SeveritySchema,
  rearm: z.boolean(),
}).partial().strict();

/** Price levels inside an alert condition, for the "is this absurdly far from the market" check. */
function alertPrices(c: AlertCondition): number[] {
  switch (c.type) {
    case 'price_cross': case 'candle_close': return [c.level];
    case 'zone': return c.target.kind === 'range' ? [c.target.low, c.target.high] : [];
    default: return [];
  }
}

const AnalysisSchema = z.object({
  noSetup: z.boolean().describe('True when there is no clear setup. This is a valid, good answer.'),
  dataReference: z.object({ timeframes: z.array(TimeframeSchema).min(1), asOf: z.string().describe('Time of the last candle used, broker clock, ISO-8601'), feed: z.string().describe('Feed/broker name as given by get_chart_state') }),
  marketStructure: z.object({ state: z.enum(['bullish', 'bearish', 'ranging', 'unclear']), summary: z.string().max(600) }),
  levels: z.array(z.object({ price: z.number().positive(), kind: z.enum(['support', 'resistance', 'supply', 'demand', 'pivot', 'other']), reason: z.string().max(300) })).max(12),
  scenarios: z.array(z.object({ condition: z.string().max(300), outcome: z.string().max(300) })).max(4),
  invalidation: z.string().max(400),
  missingInformation: z.array(z.string().max(200)).max(8),
  actionsTaken: z.array(z.string().max(200)).max(10).describe('What you created/edited on the chart, if anything.'),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const AI_TOOLS: AiTool[] = [
  {
    name: 'submit_analysis',
    description: 'Deliver the final structured analysis card to the user. Call exactly once at the end of any analysis request. Use noSetup=true when there is no clear setup.',
    input: AnalysisSchema, needs: (p) => p.chartRead, needsLabel: 'Chart read',
    run: () => ({ ok: true, data: { recorded: true } }),
  },
  {
    name: 'get_chart_state',
    description: 'Current symbol, timeframe, live bid/ask/spread, feed status, account type (demo/live) and balance, selected drawing id.',
    input: z.object({}), needs: (p) => p.chartRead, needsLabel: 'Chart read',
    run(ctx) {
      const st = ctx.getState();
      if (ctx.exposeBalance || !st.account) return { ok: true, data: st };
      const { balance: _b, equity: _e, ...account } = st.account;
      return { ok: true, data: { ...st, account } };
    },
  },
  {
    name: 'get_candles',
    description: 'Most recent OHLC candles from the live MT5 feed (oldest first). Times are broker server time (unix seconds). Never guess prices; call this.',
    input: z.object({ timeframe: TimeframeSchema.optional(), count: z.number().int().min(1).max(500).default(200) }),
    needs: (p) => p.chartRead, needsLabel: 'Chart read',
    async run(ctx, input: { timeframe?: Timeframe; count: number }) {
      const tf = input.timeframe ?? ctx.getState().timeframe;
      try {
        const c = await ctx.getCandles(tf, input.count);
        return { ok: true, data: { timeframe: tf, count: c.length, columns: ['time', 'open', 'high', 'low', 'close', 'volume'], candles: c.map((k) => [k.time, k.open, k.high, k.low, k.close, k.volume]) } };
      } catch (e) {
        return fail('unavailable', e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: 'list_drawings',
    description: 'All drawings on the chart with ids, geometry, style, layer (manual/ai), lock state. Use ids from here for updates.',
    input: z.object({ layer: z.enum(['manual', 'ai']).optional(), kind: z.string().optional() }),
    needs: (p) => p.chartRead, needsLabel: 'Chart read',
    run: (ctx, input: { layer?: 'manual' | 'ai'; kind?: string }) => ({
      ok: true, data: ctx.store.list().filter((d) => (!input.layer || d.layer === input.layer) && (!input.kind || d.kind === input.kind)),
    }),
  },
  {
    name: 'create_drawing',
    description: 'Create one or more drawings (levels, zones, trendlines, fib, entry/SL/TP position). All items are applied together and undone together. Each needs a short reason. A position drawing is a plan on the chart, NOT an order.',
    input: z.object({ items: z.array(NewDrawing).min(1).max(20) }),
    needs: (p) => p.drawingsEdit, needsLabel: 'Drawings edit',
    run(ctx, input: { items: NewDrawingInput[] }) {
      const bad = priceSanity(ctx, input.items.flatMap(pricesOf));
      if (bad) return fail('invalid_input', bad);
      const commandId = cid(ctx);
      const drawings = input.items.map((d) => toDrawing(ctx, d, commandId));
      for (const d of drawings) {
        if (d.kind === 'position') { const issues = positionIssues(d); if (issues.length) return fail('invalid_input', issues.join(' ')); }
      }
      const r = ctx.store.dispatch({ commandId, actor: 'ai', label: `AI created ${drawings.length} drawing(s)`, ops: drawings.map((drawing) => ({ op: 'create', drawing })) });
      return r.ok ? { ok: true, data: { commandId, created: drawings.map((d) => ({ id: d.id, kind: d.kind })) } } : fail('rejected', r.error);
    },
  },
  {
    name: 'update_drawing',
    description: 'Change existing drawings by id (move a level, resize a zone, relabel, change colour/timeframes). Locked drawings cannot be changed. Applied as one undoable batch.',
    input: z.object({ updates: z.array(z.object({ id: z.string(), patch: Patchable, reason: Reason })).min(1).max(20) }),
    needs: (p) => p.drawingsEdit, needsLabel: 'Drawings edit',
    run(ctx, input: { updates: { id: string; patch: Record<string, unknown> }[] }) {
      const nums = input.updates.flatMap((u) => ['price', 'entry', 'stopLoss'].map((k) => u.patch[k]).filter((v): v is number => typeof v === 'number'));
      const bad = priceSanity(ctx, nums);
      if (bad) return fail('invalid_input', bad);
      const commandId = cid(ctx);
      const ops: DrawingOp[] = input.updates.map((u) => ({ op: 'update', id: u.id, patch: u.patch }));
      const r = ctx.store.dispatch({ commandId, actor: 'ai', label: `AI updated ${ops.length} drawing(s)`, ops });
      return r.ok ? { ok: true, data: { commandId, updated: input.updates.map((u) => u.id) } } : fail('rejected', r.error);
    },
  },
  {
    name: 'delete_drawing',
    description: 'Delete specific drawings by id. Locked drawings cannot be deleted. For several ids this is one undoable batch.',
    input: z.object({ ids: z.array(z.string()).min(1).max(20), reason: Reason }),
    needs: (p) => p.drawingsEdit, needsLabel: 'Drawings edit',
    run(ctx, input: { ids: string[] }) {
      const commandId = cid(ctx);
      const r = ctx.store.dispatch({ commandId, actor: 'ai', label: `AI deleted ${input.ids.length} drawing(s)`, ops: input.ids.map((id) => ({ op: 'delete', id })) });
      return r.ok ? { ok: true, data: { commandId, deleted: input.ids } } : fail('rejected', r.error);
    },
  },
  {
    name: 'calculate_risk_reward',
    description: 'Deterministic risk maths (code, not the model): pips, reward:risk per target, and lot size for a risk % of the real account balance using the broker contract spec.',
    input: z.object({ side: z.enum(['buy', 'sell']), entry: z.number().positive(), stopLoss: z.number().positive(), takeProfits: z.array(z.number().positive()).max(5).default([]), riskPct: z.number().positive().max(100).default(0.5) }),
    needs: (p) => p.chartRead, needsLabel: 'Chart read',
    run(ctx, i: { side: 'buy' | 'sell'; entry: number; stopLoss: number; takeProfits: number[]; riskPct: number }) {
      const probe = makeDrawing({ kind: 'position', side: i.side, entryTime: 0, entry: i.entry, stopLoss: i.stopLoss, takeProfits: i.takeProfits.map((price) => ({ price, closePct: 0 })) }) as Extract<Drawing, { kind: 'position' }>;
      const issues = positionIssues(probe).filter((m) => !m.includes('more than 100'));
      const st = ctx.getState();
      const spec = ctx.getSpec();
      const dist = Math.abs(i.entry - i.stopLoss);
      const sized = spec && st.account?.balance ? lotsForRisk({ balance: st.account.balance, riskPct: i.riskPct, slDistance: dist, spec }) : null;
      return {
        ok: true,
        data: {
          issues, slDistance: dist, slPips: priceToPips(dist, st.pipSize),
          targets: i.takeProfits.map((p) => ({ price: p, pips: priceToPips(Math.abs(p - i.entry), st.pipSize), rewardRisk: rewardRisk(probe, p) })),
          sizing: !sized ? 'unavailable: needs a connected MT5 account and contract spec' : ctx.exposeBalance ? sized : { lots: sized.lots, blocked: sized.blocked ?? null },
          currency: st.account?.currency ?? null,
        },
      };
    },
  },
  {
    name: 'create_alert',
    description: 'Create a local alert (code evaluates it on the live MT5 feed; you are not called on ticks). Kinds: price_cross, zone (touch/enter/exit; drawing id or explicit range), trendline (drawing id), candle_close, spread, feed, position_plan (entry/sl/tp of a position drawing), session (open/close of sydney/tokyo/london/newyork), schedule (one-off ISO time with offset, or daily HH:MM in an IANA timezone). Repeat defaults to once. Levels must come from tools, never from memory.',
    input: z.object({
      name: z.string().max(80).optional(),
      condition: AlertConditionSchema,
      repeat: RepeatSchema.optional(),
      expiresAt: z.iso.datetime({ offset: true }).optional().describe('ISO-8601 time with offset after which the alert stops.'),
      channels: ChannelsSchema.partial().optional().describe('desktop (default on), whatsapp (flag only), sound'),
      message: z.string().max(500).optional().describe('Optional template: {name} {price} {level} {reason} {time} {symbol}.'),
      severity: SeveritySchema.optional(),
      reason: Reason,
    }),
    needs: (p) => p.alertsAndSetups, needsLabel: 'Alerts and setups',
    async run(ctx, input: { name?: string; condition: AlertCondition; repeat?: Repeat; expiresAt?: string; channels?: Partial<Channels>; message?: string; severity?: z.infer<typeof SeveritySchema>; reason: string }) {
      if (!ctx.alerts) return fail('unavailable', 'Alerts are not available in this session.');
      const bad = priceSanity(ctx, alertPrices(input.condition)) ?? referenceIssue(input.condition, ctx.store.list());
      if (bad) return fail('invalid_input', bad);
      const commandId = cid(ctx);
      const alert = makeAlert(input.condition, {
        id: ctx.newId?.() ?? globalThis.crypto.randomUUID(), actor: 'ai', now: ctx.now?.() ?? Date.now(), commandId, reason: input.reason,
        name: input.name, repeat: input.repeat, expiresAt: input.expiresAt ? Date.parse(input.expiresAt) : null, channels: input.channels, message: input.message, severity: input.severity,
      });
      const r = await ctx.alerts.dispatch({ commandId, actor: 'ai', label: `AI created alert "${alert.name}"`, ops: [{ op: 'create', alert }] });
      return r.ok ? { ok: true, data: { commandId, id: alert.id, name: alert.name } } : fail('rejected', r.error);
    },
  },
  {
    name: 'list_alerts',
    description: 'All alerts with id, condition, repeat policy, status (armed/disabled/done/expired/waiting/invalid), fire count and last fired time. Use ids from here for update_alert / delete_alert.',
    input: z.object({}),
    needs: (p) => p.alertsAndSetups, needsLabel: 'Alerts and setups',
    async run(ctx) {
      if (!ctx.alerts) return fail('unavailable', 'Alerts are not available in this session.');
      const snap = await ctx.alerts.snapshot();
      return { ok: true, data: snap.alerts.map((v) => ({ id: v.alert.id, name: v.alert.name, enabled: v.alert.enabled, origin: v.alert.origin.by, condition: v.alert.condition, summary: v.summary, repeat: v.alert.repeat, expiresAt: v.alert.expiresAt, channels: v.alert.channels, severity: v.alert.severity, status: v.status, statusDetail: v.statusDetail, fireCount: v.fireCount, lastFiredAt: v.lastFiredAt, nextAt: v.nextAt })) };
    },
  },
  {
    name: 'update_alert',
    description: 'Change alerts by id: rename, enable/disable, new condition/level, repeat policy, expiry (ISO or null), channels, message, severity. rearm=true clears "already fired". Changing the condition re-arms it. One undoable batch.',
    input: z.object({ updates: z.array(z.object({ id: z.string(), patch: AiAlertPatch, reason: Reason })).min(1).max(20) }),
    needs: (p) => p.alertsAndSetups, needsLabel: 'Alerts and setups',
    async run(ctx, input: { updates: { id: string; patch: z.infer<typeof AiAlertPatch> }[] }) {
      if (!ctx.alerts) return fail('unavailable', 'Alerts are not available in this session.');
      for (const u of input.updates) {
        if (!u.patch.condition) continue;
        const bad = priceSanity(ctx, alertPrices(u.patch.condition)) ?? referenceIssue(u.patch.condition, ctx.store.list());
        if (bad) return fail('invalid_input', bad);
      }
      const commandId = cid(ctx);
      const ops = input.updates.map((u) => {
        const { expiresAt, ...rest } = u.patch;
        return { op: 'update' as const, id: u.id, patch: { ...rest, ...(expiresAt === undefined ? {} : { expiresAt: expiresAt === null ? null : Date.parse(expiresAt) }) } };
      });
      const r = await ctx.alerts.dispatch({ commandId, actor: 'ai', label: `AI updated ${ops.length} alert(s)`, ops });
      return r.ok ? { ok: true, data: { commandId, updated: input.updates.map((u) => u.id) } } : fail('rejected', r.error);
    },
  },
  {
    name: 'delete_alert',
    description: 'Delete alerts by id (one undoable batch).',
    input: z.object({ ids: z.array(z.string()).min(1).max(20), reason: Reason }),
    needs: (p) => p.alertsAndSetups, needsLabel: 'Alerts and setups',
    async run(ctx, input: { ids: string[] }) {
      if (!ctx.alerts) return fail('unavailable', 'Alerts are not available in this session.');
      const commandId = cid(ctx);
      const r = await ctx.alerts.dispatch({ commandId, actor: 'ai', label: `AI deleted ${input.ids.length} alert(s)`, ops: input.ids.map((id) => ({ op: 'delete' as const, id })) });
      return r.ok ? { ok: true, data: { commandId, deleted: input.ids } } : fail('rejected', r.error);
    },
  },
  {
    name: 'get_notifications',
    description: 'Recent alert fires (newest first) with the reason and exact values the code used, plus what happened to each notification (sent, suppressed by quiet hours/throttle, failed) per channel.',
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    needs: (p) => p.alertsAndSetups, needsLabel: 'Alerts and setups',
    async run(ctx, input: { limit: number }) {
      if (!ctx.alerts) return fail('unavailable', 'Alerts are not available in this session.');
      const snap = await ctx.alerts.snapshot();
      const byId = new Map(snap.notifications.map((n) => [n.event.id, n]));
      return { ok: true, data: snap.fires.slice(0, input.limit).map((f) => ({ at: f.at, kind: f.kind, alertId: f.alertId, alert: f.alertName, reason: f.reason, values: f.values, severity: f.severity, deliveries: f.notificationId ? (byId.get(f.notificationId)?.deliveries ?? []) : [] })) };
    },
  },
  {
    name: 'undo_action',
    description: "Undo AI drawing changes. scope 'last' reverts the most recent change (any author); 'all_ai_today' reverts every AI change made today.",
    input: z.object({ scope: z.enum(['last', 'all_ai_today']) }),
    needs: (p) => p.drawingsEdit, needsLabel: 'Drawings edit',
    run(ctx, input: { scope: 'last' | 'all_ai_today' }) {
      if (input.scope === 'last') {
        const last = ctx.store.history().at(-1);
        if (last && last.actor !== 'ai') return fail('rejected', 'The latest change was made by the user; the AI will not undo it.');
        const e = ctx.store.undo();
        return e ? { ok: true, data: { undone: e.label } } : fail('rejected', 'Nothing to undo.');
      }
      return { ok: true, data: { reverted: ctx.store.revertActor('ai', ctx.startOfToday()) } };
    },
  },
];

export function runAiTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> | ToolResult {
  const tool = AI_TOOLS.find((t) => t.name === name);
  if (!tool) return fail('invalid_input', `Unknown tool '${name}'.`);
  if (tool.needs && !tool.needs(ctx.permissions)) {
    return fail('permission_denied', `${tool.needsLabel} is turned off in Settings > AI permissions. Ask the user to enable it.`);
  }
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) return fail('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return tool.run(ctx, parsed.data as never);
}

/** Tool definitions to hand to an LLM provider adapter. Tools the user has not allowed are not offered at all. */
export function toolCatalog(perms: AiPermissions) {
  return AI_TOOLS.filter((t) => !t.needs || t.needs(perms)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
  }));
}

export { DrawingSchema };
