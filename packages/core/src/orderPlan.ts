import { sizeOrder } from './orders';
import type { ContractSpec } from './risk';
import type { RiskSettings } from './settings';
import type { CommandBody, OpenMarketCommand, OpenPendingCommand } from './orderCommand';

/**
 * Turn a "Long/Short position" drawing into an order request. Pure; lot size comes from the risk engine, never from
 * the LLM. Multi-TP is ONE position: the farthest target becomes the real take profit, the other targets are only
 * PLANNED partial closes (nothing closes them automatically in this version).
 */
export interface PlanDrawing { side: 'buy' | 'sell'; entry: number; stopLoss: number; takeProfits: { price: number; closePct: number }[]; riskPct: number }

export interface PlanInput {
  drawing: PlanDrawing;
  balance: number;
  spec: ContractSpec & { digits?: number };
  tick: { bid: number; ask: number };
  risk: Pick<RiskSettings, 'maxRiskPerTradePct' | 'maxSlippage'>;
  commissionPerLot?: number;
}

type PlanBody = CommandBody<OpenMarketCommand> | CommandBody<OpenPendingCommand>;

export type OrderPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      kind: 'market' | 'pending';
      body: PlanBody;
      lots: number;
      riskPct: number;
      riskMoney: number;
      cappedFrom: number | null;
      /** What is sent to the broker now. */
      placedNow: string[];
      /** What is only a plan on the chart. */
      plannedOnly: string[];
    };

const round = (v: number, digits: number) => Number(v.toFixed(digits));

export function planFromPosition(p: PlanInput): OrderPlan {
  const { drawing: d, spec } = p;
  const digits = spec.digits ?? 2;
  if (d.side === 'buy' ? !(d.stopLoss < d.entry) : !(d.stopLoss > d.entry)) return { ok: false, reason: 'The stop loss is on the wrong side of the entry.' };
  const ref = d.side === 'buy' ? p.tick.ask : p.tick.bid;
  const market = Math.abs(d.entry - ref) <= p.risk.maxSlippage;
  const entry = market ? ref : d.entry;
  if (d.side === 'buy' ? !(d.stopLoss < entry) : !(d.stopLoss > entry)) return { ok: false, reason: 'The stop loss is on the wrong side of the current price.' };
  const riskPct = Math.min(d.riskPct, p.risk.maxRiskPerTradePct);
  const sized = sizeOrder({ balance: p.balance, riskPct, entry, stopLoss: d.stopLoss, spec, commissionPerLot: p.commissionPerLot });
  if (sized.blocked && sized.blocked !== 'above_max_volume') {
    return { ok: false, reason: sized.blocked === 'below_min_volume' ? 'Even the minimum lot would risk more than the budget for this stop distance.' : 'Lot size cannot be calculated (needs balance, risk % and a stop distance).' };
  }
  const tps = d.takeProfits.filter((t) => (d.side === 'buy' ? t.price > entry : t.price < entry));
  const far = tps.length ? tps.reduce((a, b) => (d.side === 'buy' ? (b.price > a.price ? b : a) : b.price < a.price ? b : a)) : null;
  const sl = round(d.stopLoss, digits);
  const tp = far ? round(far.price, digits) : null;
  const plannedTps = tps.map((t) => ({ price: round(t.price, digits), closePct: t.closePct }));
  const common = { volume: sized.lots, sl, tp, riskPct, ...(plannedTps.length ? { plannedTps } : {}) };
  let body: PlanBody;
  let pendingType = '';
  if (market) body = { type: 'open_market', side: d.side, deviationPoints: 20, ...common };
  else {
    const orderType = d.side === 'buy' ? (d.entry < p.tick.ask ? 'buy_limit' : 'buy_stop') : d.entry > p.tick.bid ? 'sell_limit' : 'sell_stop';
    pendingType = orderType;
    body = { type: 'open_pending', orderType, price: round(d.entry, digits), ...common };
  }
  const placedNow = [
    market ? `${d.side.toUpperCase()} ${sized.lots} lot at market (about ${ref.toFixed(2)})` : `Pending ${pendingType.replace('_', ' ').toUpperCase()} ${sized.lots} lot at ${d.entry.toFixed(2)}`,
    `Stop loss ${sl.toFixed(2)}`,
    tp === null ? 'No take profit' : `Take profit ${tp.toFixed(2)}${plannedTps.length > 1 ? ' (the farthest target)' : ''}`,
  ];
  const plannedOnly = plannedTps.length > 1
    ? plannedTps.filter((t) => t.price !== tp).map((t, i) => `TP${i + 1} at ${t.price.toFixed(2)}: close ${t.closePct}% of the position. NOT placed. Aurum will not do this automatically; use Partial close in the Positions tab when price gets there.`)
    : [];
  if (sized.blocked === 'above_max_volume') placedNow.push('Lot size capped at the broker maximum.');
  return { ok: true, kind: market ? 'market' : 'pending', body, lots: sized.lots, riskPct, riskMoney: sized.actualRisk, cappedFrom: d.riskPct > p.risk.maxRiskPerTradePct ? d.riskPct : null, placedNow, plannedOnly };
}
