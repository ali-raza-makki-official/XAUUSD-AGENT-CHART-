import { floorToStep, lossPerLot, lotsForRisk, type ContractSpec, type LotResult } from './risk';

/** Same literal as bridge/aurum_bridge/trading.py AURUM_MAGIC ("AURU"). */
export const AURUM_MAGIC = 1096041045;

/** Is `volume` a valid broker volume (min/max, step counted from min)? Pure, no rounding. */
export function isValidVolume(volume: number, spec: Pick<ContractSpec, 'volumeMin' | 'volumeMax' | 'volumeStep'>): boolean {
  if (!Number.isFinite(volume) || volume < spec.volumeMin - 1e-12 || volume > spec.volumeMax + 1e-12) return false;
  const n = (volume - spec.volumeMin) / spec.volumeStep;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

/** Lot size for a risk %, using the real contract spec. Never rounds up, so risk never exceeds the budget. */
export function sizeOrder(req: { balance: number; riskPct: number; entry: number; stopLoss: number; spec: ContractSpec; commissionPerLot?: number }): LotResult {
  return lotsForRisk({ balance: req.balance, riskPct: req.riskPct, slDistance: Math.abs(req.entry - req.stopLoss), spec: req.spec, commissionPerLot: req.commissionPerLot });
}

/**
 * Volume for a partial close of `fraction` (0..1) of a position. Rounded DOWN to the volume step, never above or equal
 * to the position, and the remainder must still be a valid volume. Returns null when no such volume exists.
 */
export function partialCloseVolume(positionVolume: number, fraction: number, spec: ContractSpec): number | null {
  if (!(fraction > 0) || !(fraction < 1) || !(positionVolume > 0)) return null;
  const vol = floorToStep(positionVolume * fraction, spec.volumeStep);
  const remainder = Number((positionVolume - vol).toFixed(8));
  if (vol < spec.volumeMin - 1e-12 || vol >= positionVolume - 1e-12) return null;
  if (remainder < spec.volumeMin - 1e-12) return null;
  if (!isValidVolume(vol, spec)) return null;
  return vol;
}

/** Money at risk if price travels from the open price to the SL (0 when the SL already locks profit). */
export function riskAtSl(spec: ContractSpec, side: 'buy' | 'sell', priceOpen: number, sl: number | null, volume: number): number {
  if (sl === null) return Infinity;
  const dist = side === 'buy' ? priceOpen - sl : sl - priceOpen;
  return dist <= 0 ? 0 : volume * lossPerLot(spec, dist);
}

/**
 * manage_only policy: once the daily limit is hit, moving the SL so that the position risks MORE (or removing it)
 * is blocked; moving it toward safety is allowed.
 */
export function slMoveAllowedAfterLimit(spec: ContractSpec, side: 'buy' | 'sell', priceOpen: number, volume: number, oldSl: number | null, newSl: number | null): boolean {
  return riskAtSl(spec, side, priceOpen, newSl, volume) <= riskAtSl(spec, side, priceOpen, oldSl, volume) + 1e-9;
}
