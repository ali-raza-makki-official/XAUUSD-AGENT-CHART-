import { z } from 'zod';
import { lotsForRisk, pipsToPrice, priceToPips, type ContractSpec } from './risk';
import { partialCloseVolume } from './orders';

/**
 * Trade Assistant: plans the user approves in advance, and management rules written in PIPS (never money).
 * Everything here is pure arithmetic on real prices; the order engine and risk gate still decide whether anything is sent.
 * 1 pip = pipSize in price (0.10 on gold by default), so 50 pips on gold is 5.00 in price.
 */

const Pips = z.number().positive().max(5000);

export const ManageRulesSchema = z.object({
  /** Move the stop to entry (+ a small cushion) once the trade is this many pips in profit. */
  breakeven: z.object({ enabled: z.boolean().default(true), triggerPips: Pips.default(50), offsetPips: z.number().min(0).max(500).default(2) }).default(() => ({ enabled: true, triggerPips: 50, offsetPips: 2 })),
  /** After startPips of profit keep the stop distancePips behind price, moving it only in steps of stepPips. */
  trail: z.object({ enabled: z.boolean().default(false), startPips: Pips.default(100), distancePips: Pips.default(60), stepPips: Pips.default(10) }).default(() => ({ enabled: false, startPips: 100, distancePips: 60, stepPips: 10 })),
  /** Close this share of the position once, at atPips of profit. */
  partial: z.object({ enabled: z.boolean().default(false), atPips: Pips.default(100), closePct: z.number().min(5).max(95).default(50) }).default(() => ({ enabled: false, atPips: 100, closePct: 50 })),
});
export type ManageRules = z.infer<typeof ManageRulesSchema>;

export const AssistantSettingsSchema = z.object({
  /** Master switch. While off nothing automatic happens, whatever else is set. */
  enabled: z.boolean().default(false),
  /** Apply the management rules to open gold positions automatically (each action is announced). */
  autoManage: z.boolean().default(false),
  rules: ManageRulesSchema.default(() => ManageRulesSchema.parse({})),
  /** Defaults for new plans, in pips. */
  defaults: z.object({ slPips: Pips.default(70), tpPips: Pips.default(140), riskPct: z.number().positive().max(5).default(0.3), expiryHours: z.number().positive().max(720).default(24) }).default(() => ({ slPips: 70, tpPips: 140, riskPct: 0.3, expiryHours: 24 })),
});
export type AssistantSettings = z.infer<typeof AssistantSettingsSchema>;
export const DEFAULT_ASSISTANT: AssistantSettings = AssistantSettingsSchema.parse({});

// ---------------------------------------------------------------------------------------------- plans

export const PlanStatusSchema = z.enum(['proposed', 'armed', 'asking', 'placing', 'filled', 'skipped', 'cancelled', 'expired', 'blocked']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const TradePlanSchema = z.object({
  id: z.string().min(8).max(80),
  createdAt: z.number().int(),
  createdBy: z.enum(['ai', 'manual']),
  side: z.enum(['buy', 'sell']),
  /** The zone the plan waits for, in price. */
  zone: z.object({ low: z.number().positive(), high: z.number().positive() }).refine((z) => z.high > z.low, 'zone high must be above low'),
  /** touch = market order when price reaches the zone; limit = a pending order placed at the zone edge as soon as the plan is approved. */
  entry: z.enum(['touch', 'limit']).default('touch'),
  slPips: Pips,
  tpPips: Pips.nullable(),
  riskPct: z.number().positive().max(5),
  /** true = the assistant places the order itself when price reaches the zone (after the user approved this plan). false = it asks first. */
  autoTake: z.boolean().default(false),
  expiresAt: z.number().int(),
  status: PlanStatusSchema,
  statusDetail: z.string().max(400).default(''),
  note: z.string().max(500).default(''),
  /** Drawing the zone came from, if any. */
  drawingId: z.string().max(80).optional(),
  commandId: z.string().max(80).optional(),
  ticket: z.number().int().optional(),
  approvedAt: z.number().int().optional(),
});
export type TradePlan = z.infer<typeof TradePlanSchema>;

/** Price has reached the zone: buys wait for the ask to come down into it, sells for the bid to come up into it. */
export function zoneReached(plan: Pick<TradePlan, 'side' | 'zone'>, tick: { bid: number; ask: number }): boolean {
  return plan.side === 'buy' ? tick.ask <= plan.zone.high && tick.ask >= plan.zone.low : tick.bid >= plan.zone.low && tick.bid <= plan.zone.high;
}

/** Price went straight through the zone without a touch we could act on (so the plan's idea is already broken). */
export function zoneBroken(plan: Pick<TradePlan, 'side' | 'zone'>, tick: { bid: number; ask: number }): boolean {
  return plan.side === 'buy' ? tick.ask < plan.zone.low : tick.bid > plan.zone.high;
}

export interface PlanOrder {
  type: 'open_market' | 'open_pending';
  body: Record<string, unknown>;
  lots: number;
  entry: number;
  sl: number;
  tp: number | null;
  slPips: number;
  tpPips: number | null;
  riskMoney: number;
}

/** The order a plan turns into, sized from its risk % and stop distance in pips. Never guesses: returns an error sentence instead. */
export function planOrder(plan: TradePlan, o: { tick: { bid: number; ask: number } | null; spec: ContractSpec | null; balance: number | null; pipSize: number }): PlanOrder | { error: string } {
  if (!o.spec) return { error: 'The broker contract specification is not available yet.' };
  if (o.balance === null || !(o.balance > 0)) return { error: 'Account balance is not available.' };
  const buy = plan.side === 'buy';
  let entry: number;
  if (plan.entry === 'limit') entry = buy ? plan.zone.high : plan.zone.low;
  else if (!o.tick) return { error: 'No live quote.' };
  else entry = buy ? o.tick.ask : o.tick.bid;
  const slDist = pipsToPrice(plan.slPips, o.pipSize);
  const sl = buy ? entry - slDist : entry + slDist;
  const tp = plan.tpPips === null ? null : buy ? entry + pipsToPrice(plan.tpPips, o.pipSize) : entry - pipsToPrice(plan.tpPips, o.pipSize);
  const size = lotsForRisk({ balance: o.balance, riskPct: plan.riskPct, slDistance: slDist, spec: o.spec });
  if (size.blocked === 'below_min_volume') return { error: `${plan.riskPct}% risk with a ${plan.slPips}-pip stop is below the smallest lot size (${o.spec.volumeMin}). Raise the risk % or narrow the stop.` };
  if (size.blocked && size.blocked !== 'above_max_volume') return { error: 'The lot size could not be computed.' };
  const round = (v: number) => Math.round(v * 100) / 100;
  const base = { volume: size.lots, sl: round(sl), tp: tp === null ? null : round(tp), riskPct: plan.riskPct, planId: plan.id, reason: `Plan ${plan.id.slice(0, 8)}: ${plan.side} ${plan.slPips} pip stop`.slice(0, 300) };
  const body = plan.entry === 'limit'
    ? { type: 'open_pending', orderType: buy ? 'buy_limit' : 'sell_limit', price: round(entry), expiration: Math.floor(plan.expiresAt / 1000), ...base }
    : { type: 'open_market', side: plan.side, deviationPoints: 20, ...base };
  return { type: plan.entry === 'limit' ? 'open_pending' : 'open_market', body, lots: size.lots, entry: round(entry), sl: round(sl), tp: tp === null ? null : round(tp), slPips: plan.slPips, tpPips: plan.tpPips, riskMoney: size.actualRisk };
}

// ---------------------------------------------------------------------------------------- management

export interface ManagedPosition { ticket: number; type: 'buy' | 'sell'; volume: number; priceOpen: number; sl: number | null; tp: number | null }
/** What the manager remembers per position so a rule never fires twice. */
export interface ManageState { partialDone: boolean }
export type ManageAction =
  | { kind: 'sl'; ticket: number; newSl: number; why: 'breakeven' | 'trail'; text: string }
  | { kind: 'partial'; ticket: number; volume: number; text: string };

/** Floating profit of a position in pips, measured at the price it would be closed at (bid for buys, ask for sells). */
export function profitPips(p: Pick<ManagedPosition, 'type' | 'priceOpen'>, tick: { bid: number; ask: number }, pipSize: number): number {
  return priceToPips(p.type === 'buy' ? tick.bid - p.priceOpen : p.priceOpen - tick.ask, pipSize);
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** "+53.2 pips" style text. */
export const fmtPips = (n: number) => `${n > 0 ? '+' : ''}${(Math.round(n * 10) / 10).toFixed(1)} pips`;

/**
 * The rules for one position at one moment. Pure and idempotent: ask again with the same inputs and the same answer comes back,
 * and once the stop has moved the rule no longer applies, so nothing repeats. Stops only ever move toward profit.
 */
export function manageDecisions(pos: ManagedPosition, tick: { bid: number; ask: number }, rules: ManageRules, state: ManageState, o: { pipSize: number; spec: ContractSpec | null }): ManageAction[] {
  const out: ManageAction[] = [];
  const buy = pos.type === 'buy';
  const pips = profitPips(pos, tick, o.pipSize);
  const better = (candidate: number) => (pos.sl === null ? true : buy ? candidate > pos.sl + 1e-9 : candidate < pos.sl - 1e-9);
  const safe = (sl: number) => (buy ? sl < tick.bid : sl > tick.ask); // the broker rejects a stop on the wrong side of the market

  if (rules.partial.enabled && !state.partialDone && pips >= rules.partial.atPips && o.spec) {
    const v = partialCloseVolume(pos.volume, rules.partial.closePct / 100, o.spec);
    if (v !== null) out.push({ kind: 'partial', ticket: pos.ticket, volume: v, text: `Take ${rules.partial.closePct}% (${v} lot) at ${fmtPips(pips)}` });
  }

  let best: { sl: number; why: 'breakeven' | 'trail'; text: string } | null = null;
  if (rules.breakeven.enabled && pips >= rules.breakeven.triggerPips) {
    const sl = r2(buy ? pos.priceOpen + pipsToPrice(rules.breakeven.offsetPips, o.pipSize) : pos.priceOpen - pipsToPrice(rules.breakeven.offsetPips, o.pipSize));
    if (better(sl) && safe(sl)) best = { sl, why: 'breakeven', text: `Stop to breakeven ${rules.breakeven.offsetPips >= 0 ? '+' : ''}${rules.breakeven.offsetPips} pips (${sl.toFixed(2)}) at ${fmtPips(pips)}` };
  }
  if (rules.trail.enabled && pips >= rules.trail.startPips) {
    const sl = r2(buy ? tick.bid - pipsToPrice(rules.trail.distancePips, o.pipSize) : tick.ask + pipsToPrice(rules.trail.distancePips, o.pipSize));
    const stepOk = pos.sl === null || Math.abs(sl - pos.sl) >= pipsToPrice(rules.trail.stepPips, o.pipSize) - 1e-9;
    if (better(sl) && stepOk && safe(sl) && (!best || (buy ? sl > best.sl : sl < best.sl))) best = { sl, why: 'trail', text: `Trail stop to ${sl.toFixed(2)} (${rules.trail.distancePips} pips behind price) at ${fmtPips(pips)}` };
  }
  if (best) out.push({ kind: 'sl', ticket: pos.ticket, newSl: best.sl, why: best.why, text: best.text });
  return out;
}

