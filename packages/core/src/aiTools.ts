import { z } from 'zod';
import { type AiPermissions } from './settings';
import { DrawingStore, type DrawingOp } from './drawingStore';
import { DrawingSchema, makeDrawing, positionIssues, rewardRisk, type Drawing } from './drawing';
import { lotsForRisk, priceToPips, type ContractSpec } from './risk';
import { TimeframeSchema, type Candle, type Timeframe } from './feed';
import { AlertConditionSchema, ChannelsSchema, RepeatSchema, SeveritySchema, makeAlert, referenceIssue, type AlertCondition, type Channels, type Repeat } from './alerts';
import { type AlertCommand, type AlertDispatchResult } from './alertStore';
import { type AlertsSnapshot } from './alertMonitor';
import { IndicatorStore, IndicatorSchema, makeIndicator, indicatorTitle, outputStyle, type IndicatorOp } from './indicatorStore';
import { INDICATORS, INDICATOR_TYPES, computeIndicator, resolveParams, tailValues, warmupBars, type IndicatorType } from './indicators';
import { ChartLayoutSchema, LAYOUT_PANES, clampPane, type ChartLayout } from './chartLayout';
import { CONTEXT_TOOLS, type ContextAccess } from './contextTools';
import { ORDER_TOOLS, type OrdersPort } from './orderTools';

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
  /** Chart workspace. Optional so older callers keep working. */
  layout?: ChartLayout;
  /** Timeframe of every visible pane, in pane order (index 0 = top-left). `timeframe` above is the active pane's. */
  paneTimeframes?: Timeframe[];
  activePane?: number;
  syncScroll?: boolean;
}

/** View-state controls the app exposes to the AI (same functions the layout buttons call). */
export interface ChartControl {
  setLayout(layout: ChartLayout, paneTimeframes?: Timeframe[]): void | Promise<void>;
  setPaneTimeframe(pane: number, tf: Timeframe): void | Promise<void>;
  setSyncScroll(on: boolean): void | Promise<void>;
}

export interface ToolContext {
  store: DrawingStore;
  /** Indicator instances (same store the Indicators dialog uses). */
  indicators?: IndicatorStore;
  chart?: ChartControl;
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
  /** Market context (sessions, calendar, news, sentiment, related markets). Absent = tools report unavailable. */
  context?: ContextAccess;
  /** Order previews (propose_order_action). Absent = the tool reports unavailable. */
  orders?: OrdersPort;
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

/** Candles used to compute indicators; matches what the chart loads so AI values equal what the user sees. */
export const INDICATOR_HISTORY = 1500;

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
  {
    name: 'list_indicators',
    description: 'Catalogue of available indicators (parameters with ranges, outputs, whether it overlays price or has its own pane) plus the indicator instances currently on the chart with their ids.',
    input: z.object({}), needs: (p) => p.chartRead, needsLabel: 'Chart read',
    run(ctx) {
      return {
        ok: true,
        data: {
          catalogue: INDICATOR_TYPES.map((t) => {
            const d = INDICATORS[t];
            return { type: t, name: d.name, description: d.description, placement: d.placement, usesTickVolume: d.usesTickVolume ?? false, params: d.params, outputs: d.outputs.map((o) => ({ key: o.key, label: o.label, kind: o.kind })) };
          }),
          active: (ctx.indicators?.list() ?? []).map((i) => ({ id: i.id, type: i.type, title: indicatorTitle(i), params: i.params, visible: i.visible, timeframes: i.timeframes, locked: i.locked, layer: i.origin.by })),
        },
      };
    },
  },
  {
    name: 'get_indicator_values',
    description: 'Indicator values computed by code on the real MT5 candles (never estimate them yourself). Give an instance id from list_indicators, or a type with optional params. Returns the last `count` rows oldest first as [time, ...outputs]; null = not defined yet. The last row is the still-forming candle.',
    input: z.object({
      id: z.string().optional(),
      type: z.enum(INDICATOR_TYPES).optional(),
      params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
      timeframe: TimeframeSchema.optional(),
      count: z.number().int().min(1).max(200).default(20),
    }),
    needs: (p) => p.chartRead, needsLabel: 'Chart read',
    async run(ctx, input: { id?: string; type?: IndicatorType; params?: Record<string, number | string>; timeframe?: Timeframe; count: number }) {
      let type = input.type;
      let params: Record<string, unknown> = input.params ?? {};
      if (input.id) {
        const inst = ctx.indicators?.get(input.id);
        if (!inst) return fail('invalid_input', `Indicator ${input.id} not found. Call list_indicators for ids.`);
        type = inst.type; params = inst.params;
      }
      if (!type) return fail('invalid_input', 'Provide either an indicator id or a type.');
      const resolved = resolveParams(type, params);
      if (!resolved.ok) return fail('invalid_input', resolved.error);
      const tf = input.timeframe ?? ctx.getState().timeframe;
      let candles: Candle[];
      try { candles = await ctx.getCandles(tf, INDICATOR_HISTORY); } catch (e) { return fail('unavailable', e instanceof Error ? e.message : String(e)); }
      if (!candles.length) return fail('unavailable', 'No candles available from the feed.');
      const def = INDICATORS[type];
      const series = computeIndicator(type, candles, resolved.params);
      const keys = def.outputs.map((o) => o.key);
      const need = warmupBars(type, resolved.params);
      return {
        ok: true,
        data: {
          type, name: def.name, params: resolved.params, timeframe: tf, candlesUsed: candles.length,
          asOf: candles[candles.length - 1]!.time, lastCandleIsForming: true,
          columns: ['time', ...keys], rows: tailValues(candles, series, keys, input.count),
          ...(candles.length < need ? { warning: `Only ${candles.length} candles are available but about ${need} are needed, so values may be missing.` } : {}),
          ...(def.usesTickVolume ? { note: 'Weighted by MT5 tick volume (number of price updates), not exchange volume.' } : {}),
        },
      };
    },
  },
  {
    name: 'add_indicator',
    description: 'Add an indicator to the chart (see list_indicators for types and parameter ranges). It is marked as AI-created, can be edited by the user and undone. Omitted parameters use defaults.',
    input: z.object({
      type: z.enum(INDICATOR_TYPES),
      params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
      label: z.string().max(80).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      width: z.number().min(1).max(8).optional(),
      lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
      outputColors: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional().describe('Colour per output key, e.g. {"signal":"#ff8800"}.'),
      timeframes: z.union([z.literal('all'), z.array(TimeframeSchema)]).optional().describe("Timeframes to show on; default 'all'."),
      reason: Reason,
    }),
    needs: (p) => p.indicatorsEdit, needsLabel: 'Indicators edit',
    run(ctx, i: { type: IndicatorType; params?: Record<string, number | string>; label?: string; color?: string; width?: number; lineStyle?: 'solid' | 'dashed' | 'dotted'; outputColors?: Record<string, string>; timeframes?: 'all' | Timeframe[]; reason: string }) {
      if (!ctx.indicators) return fail('unavailable', 'Indicators are not available in this session.');
      const commandId = cid(ctx);
      try {
        const keys = INDICATORS[i.type].outputs.map((o) => o.key);
        const badKey = Object.keys(i.outputColors ?? {}).find((k) => !keys.includes(k));
        if (badKey) return fail('invalid_input', `${INDICATORS[i.type].name} has no output '${badKey}'. Outputs: ${keys.join(', ')}.`);
        const ind = makeIndicator(i.type, {
          id: ctx.newId?.() ?? globalThis.crypto.randomUUID(), actor: 'ai', now: ctx.now?.() ?? Date.now(), commandId, reason: i.reason,
          label: i.label, params: i.params, timeframes: i.timeframes,
          style: {
            ...(i.color ? { color: i.color } : {}), ...(i.width ? { width: i.width } : {}), ...(i.lineStyle ? { lineStyle: i.lineStyle } : {}),
            outputs: Object.fromEntries(Object.entries(i.outputColors ?? {}).map(([k, color]) => [k, { color }])),
          },
        });
        const r = ctx.indicators.dispatch({ commandId, actor: 'ai', label: `AI added ${indicatorTitle(ind)}`, ops: [{ op: 'create', indicator: ind }] });
        return r.ok ? { ok: true, data: { commandId, id: ind.id, type: ind.type, title: indicatorTitle(ind), params: ind.params } } : fail('rejected', r.error);
      } catch (e) {
        return fail('invalid_input', e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: 'update_indicator',
    description: 'Change indicator instances by id: parameters, label, visibility, timeframes, colour/width/line style or per-output styles. Locked indicators cannot be changed. Applied as one undoable batch.',
    input: z.object({
      updates: z.array(z.object({
        id: z.string(),
        patch: z.object({
          params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
          label: z.string().max(80).optional(),
          visible: z.boolean().optional(),
          timeframes: z.union([z.literal('all'), z.array(TimeframeSchema)]).optional(),
          style: z.object({
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            width: z.number().min(1).max(8).optional(),
            lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
            outputs: z.record(z.string(), z.object({
              color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), width: z.number().min(1).max(8).optional(),
              lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(), visible: z.boolean().optional(),
              negColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            }).strict()).optional(),
          }).strict().optional(),
        }).strict(),
        reason: Reason,
      })).min(1).max(20),
    }),
    needs: (p) => p.indicatorsEdit, needsLabel: 'Indicators edit',
    run(ctx, input: { updates: { id: string; patch: Record<string, unknown> }[] }) {
      if (!ctx.indicators) return fail('unavailable', 'Indicators are not available in this session.');
      const commandId = cid(ctx);
      const ops: IndicatorOp[] = input.updates.map((u) => ({ op: 'update', id: u.id, patch: u.patch }));
      const r = ctx.indicators.dispatch({ commandId, actor: 'ai', label: `AI updated ${ops.length} indicator(s)`, ops });
      return r.ok ? { ok: true, data: { commandId, updated: input.updates.map((u) => u.id) } } : fail('rejected', r.error);
    },
  },
  {
    name: 'remove_indicator',
    description: 'Remove indicator instances by id. Locked indicators cannot be removed. One undoable batch.',
    input: z.object({ ids: z.array(z.string()).min(1).max(20), reason: Reason }),
    needs: (p) => p.indicatorsEdit, needsLabel: 'Indicators edit',
    run(ctx, input: { ids: string[] }) {
      if (!ctx.indicators) return fail('unavailable', 'Indicators are not available in this session.');
      const commandId = cid(ctx);
      const r = ctx.indicators.dispatch({ commandId, actor: 'ai', label: `AI removed ${input.ids.length} indicator(s)`, ops: input.ids.map((id) => ({ op: 'delete', id })) });
      return r.ok ? { ok: true, data: { commandId, removed: input.ids } } : fail('rejected', r.error);
    },
  },
  {
    name: 'set_layout',
    description: "Switch the chart workspace: 'single', 'two' (side by side) or 'four' (2x2, default H4/H1/M15/M5). Optionally give the timeframes of the first panes (pane order: top-left, top-right, bottom-left, bottom-right) and turn synced scrolling on/off. All panes show the same symbol from the same MT5 feed.",
    input: z.object({ layout: ChartLayoutSchema, paneTimeframes: z.array(TimeframeSchema).min(1).max(4).optional(), syncScroll: z.boolean().optional() }),
    needs: (p) => p.chartControl, needsLabel: 'Chart control',
    async run(ctx, i: { layout: ChartLayout; paneTimeframes?: Timeframe[]; syncScroll?: boolean }) {
      if (!ctx.chart) return fail('unavailable', 'Chart layout control is not available in this session.');
      if (i.paneTimeframes && i.paneTimeframes.length > LAYOUT_PANES[i.layout]) return fail('invalid_input', `The '${i.layout}' layout has ${LAYOUT_PANES[i.layout]} pane(s) but ${i.paneTimeframes.length} timeframes were given.`);
      await ctx.chart.setLayout(i.layout, i.paneTimeframes);
      if (i.syncScroll !== undefined) await ctx.chart.setSyncScroll(i.syncScroll);
      return { ok: true, data: { layout: i.layout, panes: LAYOUT_PANES[i.layout], ...(i.syncScroll !== undefined ? { syncScroll: i.syncScroll } : {}) } };
    },
  },
  {
    name: 'set_timeframe',
    description: 'Set the timeframe of one chart pane (default: the active pane). Pane 0 is the first/top-left pane; in the single layout there is only pane 0.',
    input: z.object({ timeframe: TimeframeSchema, pane: z.number().int().min(0).max(3).optional() }),
    needs: (p) => p.chartControl, needsLabel: 'Chart control',
    async run(ctx, i: { timeframe: Timeframe; pane?: number }) {
      if (!ctx.chart) return fail('unavailable', 'Chart layout control is not available in this session.');
      const st = ctx.getState();
      const layout = st.layout ?? 'single';
      if (i.pane !== undefined && i.pane >= LAYOUT_PANES[layout]) return fail('invalid_input', `The '${layout}' layout only has panes 0 to ${LAYOUT_PANES[layout] - 1}.`);
      const pane = i.pane ?? clampPane(layout, st.activePane ?? 0);
      await ctx.chart.setPaneTimeframe(pane, i.timeframe);
      return { ok: true, data: { pane, timeframe: i.timeframe } };
    },
  },
];

AI_TOOLS.push(...CONTEXT_TOOLS, ...ORDER_TOOLS);

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
