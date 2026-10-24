/**
 * Deterministic risk maths. The LLM never calculates lot sizes; it only reads these results.
 */

export interface ContractSpec {
  /** Units per 1.0 lot (e.g. 100 oz for gold on most brokers). */
  contractSize: number;
  /** Smallest price increment used for tick value (SYMBOL_TRADE_TICK_SIZE). */
  tickSize: number;
  /** Account-currency profit of one tickSize move on 1.0 lot (SYMBOL_TRADE_TICK_VALUE). */
  tickValue: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

/** On most brokers gold has 2 decimals and 1 pip = 0.10 price. Must be confirmed per broker. */
export const DEFAULT_GOLD_PIP_SIZE = 0.1;

export const pipsToPrice = (pips: number, pipSize = DEFAULT_GOLD_PIP_SIZE) => pips * pipSize;
export const priceToPips = (distance: number, pipSize = DEFAULT_GOLD_PIP_SIZE) => distance / pipSize;

/** Loss on 1.0 lot if price moves `distance` against the position. */
export function lossPerLot(spec: ContractSpec, distance: number): number {
  return (Math.abs(distance) / spec.tickSize) * spec.tickValue;
}

function decimalsOf(step: number): number {
  const s = step.toString();
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/** Round down to the broker volume step (never round up: that would exceed the risk). */
export function floorToStep(volume: number, step: number): number {
  const n = Math.floor(volume / step + 1e-9);
  return Number((n * step).toFixed(decimalsOf(step)));
}

export type LotBlockReason = 'invalid_input' | 'below_min_volume' | 'above_max_volume';

export interface LotRequest {
  balance: number;
  riskPct: number;
  /** Absolute entry-to-SL price distance. */
  slDistance: number;
  spec: ContractSpec;
  /** Round-trip commission per 1.0 lot in account currency. */
  commissionPerLot?: number;
  /** Estimated spread cost per 1.0 lot in account currency. */
  spreadCostPerLot?: number;
}

export interface LotResult {
  lots: number;
  /** Risk the trader is willing to take (balance * riskPct). */
  riskBudget: number;
  /** Real risk at the rounded lot size, including commission and spread. */
  actualRisk: number;
  blocked?: LotBlockReason;
}

export function lotsForRisk(req: LotRequest): LotResult {
  const { balance, riskPct, slDistance, spec } = req;
  const riskBudget = (balance * riskPct) / 100;
  if (!(balance > 0) || !(riskPct > 0) || !(slDistance > 0)) {
    return { lots: 0, riskBudget, actualRisk: 0, blocked: 'invalid_input' };
  }
  const perLot =
    lossPerLot(spec, slDistance) + (req.commissionPerLot ?? 0) + (req.spreadCostPerLot ?? 0);
  const raw = riskBudget / perLot;
  const lots = floorToStep(raw, spec.volumeStep);
  if (lots < spec.volumeMin) {
    return { lots: 0, riskBudget, actualRisk: 0, blocked: 'below_min_volume' };
  }
  if (lots > spec.volumeMax) {
    return {
      lots: spec.volumeMax,
      riskBudget,
      actualRisk: spec.volumeMax * perLot,
      blocked: 'above_max_volume',
    };
  }
  return { lots, riskBudget, actualRisk: lots * perLot };
}
