import type { BrokerPosition } from './orderCommand';
import { AURUM_MAGIC } from './orders';

/**
 * Compare two MT5 position snapshots. Every difference that is not explained by one of OUR commands is labelled
 * "external change" (the owner closed, opened or edited something in the MT5 terminal, or a stop/take-profit fired).
 */
export interface PositionEvent {
  kind: 'opened' | 'closed' | 'sl_tp_changed' | 'volume_changed';
  ticket: number;
  external: boolean;
  detail: string;
  at: number;
}

const same = (a: number | null, b: number | null) => (a ?? 0) === (b ?? 0);

export function diffPositions(prev: BrokerPosition[], next: BrokerPosition[], isOwn: (ticket: number) => boolean, at: number): PositionEvent[] {
  const out: PositionEvent[] = [];
  const before = new Map(prev.map((p) => [p.ticket, p]));
  const after = new Map(next.map((p) => [p.ticket, p]));
  for (const p of next) {
    const old = before.get(p.ticket);
    const own = isOwn(p.ticket);
    if (!old) {
      out.push({ kind: 'opened', ticket: p.ticket, external: !own && p.magic !== AURUM_MAGIC, detail: `${p.type.toUpperCase()} ${p.volume} lot opened at ${p.priceOpen.toFixed(2)}`, at });
      continue;
    }
    if (!same(old.sl, p.sl) || !same(old.tp, p.tp)) {
      out.push({ kind: 'sl_tp_changed', ticket: p.ticket, external: !own, detail: `SL ${old.sl ?? 'none'} -> ${p.sl ?? 'none'}, TP ${old.tp ?? 'none'} -> ${p.tp ?? 'none'}`, at });
    }
    if (Math.abs(old.volume - p.volume) > 1e-9) {
      out.push({ kind: 'volume_changed', ticket: p.ticket, external: !own, detail: `Volume ${old.volume} -> ${p.volume} lot`, at });
    }
  }
  for (const p of prev) {
    if (!after.has(p.ticket)) out.push({ kind: 'closed', ticket: p.ticket, external: !isOwn(p.ticket), detail: `Position closed (last P/L ${p.profit.toFixed(2)})`, at });
  }
  return out;
}
