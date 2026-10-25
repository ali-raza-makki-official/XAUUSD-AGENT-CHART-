import type { BrokerDeal } from './orderCommand';

/**
 * Trading statistics from REAL closed broker deals only. Nothing is estimated or filled in:
 * a position counts as a closed trade when MT5 reports its closing deal. Money is in account currency.
 */
export interface ClosedTrade {
  positionId: number; symbol: string;
  /** Direction of the position (the closing deal is the opposite side). */
  side: 'buy' | 'sell';
  openTime: number | null; closeTime: number; volume: number;
  /** profit + commission + swap + fee, all deals of the position. */
  net: number; heldSec: number | null;
}

export interface PerformanceSummary {
  trades: number; wins: number; losses: number; breakeven: number;
  winRate: number | null;
  net: number; grossWin: number; grossLoss: number;
  profitFactor: number | null;
  avgWin: number | null; avgLoss: number | null;
  /** Average net per trade. */
  expectancy: number | null;
  /** avgWin / |avgLoss| */
  payoff: number | null;
  /** Largest peak-to-trough fall of the running net result over closed trades, as a positive money amount. */
  maxDrawdown: number;
  bestTrade: number | null; worstTrade: number | null;
  maxWinStreak: number; maxLossStreak: number;
  avgHoldMin: number | null;
  byHour: { hour: number; trades: number; net: number }[];
  byWeekday: { weekday: number; trades: number; net: number }[];
  bySide: { buy: { trades: number; net: number }; sell: { trades: number; net: number } };
}

/** Groups deals into closed trades. Balance operations and positions still open are ignored. */
export function closedTrades(deals: readonly BrokerDeal[], symbol?: string): ClosedTrade[] {
  const byPos = new Map<number, BrokerDeal[]>();
  for (const d of deals) {
    if ((d.type !== 'buy' && d.type !== 'sell') || d.positionId === 0) continue;
    if (symbol && d.symbol !== symbol) continue;
    (byPos.get(d.positionId) ?? byPos.set(d.positionId, []).get(d.positionId)!).push(d);
  }
  const out: ClosedTrade[] = [];
  for (const [positionId, list] of byPos) {
    const ins = list.filter((d) => d.entry === 'in' || d.entry === 'inout');
    const outs = list.filter((d) => d.entry === 'out' || d.entry === 'inout');
    if (!outs.length) continue;
    const opening = ins.sort((a, b) => a.time - b.time)[0];
    const closing = outs.sort((a, b) => b.time - a.time)[0]!;
    // The position's side is the side of the opening deal; if only the close is in the window it is the opposite of the close.
    const side: 'buy' | 'sell' = opening ? (opening.type as 'buy' | 'sell') : closing.type === 'buy' ? 'sell' : 'buy';
    const net = list.reduce((s, d) => s + d.profit + d.commission + d.swap + d.fee, 0);
    out.push({
      positionId, symbol: closing.symbol, side, openTime: opening?.time ?? null, closeTime: closing.time,
      volume: outs.reduce((s, d) => s + d.volume, 0), net, heldSec: opening ? closing.time - opening.time : null,
    });
  }
  return out.sort((a, b) => a.closeTime - b.closeTime);
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function summarize(trades: readonly ClosedTrade[]): PerformanceSummary {
  const wins = trades.filter((t) => t.net > 0), losses = trades.filter((t) => t.net < 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0), grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const net = trades.reduce((s, t) => s + t.net, 0);
  let run = 0, peak = 0, dd = 0, ws = 0, ls = 0, maxW = 0, maxL = 0;
  for (const t of trades) {
    run += t.net; peak = Math.max(peak, run); dd = Math.max(dd, peak - run);
    if (t.net > 0) { ws++; ls = 0; } else if (t.net < 0) { ls++; ws = 0; } else { ws = 0; ls = 0; }
    maxW = Math.max(maxW, ws); maxL = Math.max(maxL, ls);
  }
  const hold = trades.filter((t) => t.heldSec !== null).map((t) => t.heldSec!);
  const hours = new Map<number, { trades: number; net: number }>(), days = new Map<number, { trades: number; net: number }>();
  for (const t of trades) {
    const d = new Date(t.closeTime * 1000); // broker clock, read as UTC fields like the chart
    for (const [m, k] of [[hours, d.getUTCHours()], [days, d.getUTCDay()]] as const) { const e = m.get(k) ?? { trades: 0, net: 0 }; e.trades++; e.net += t.net; m.set(k, e); }
  }
  const side = (s: 'buy' | 'sell') => { const l = trades.filter((t) => t.side === s); return { trades: l.length, net: round(l.reduce((a, t) => a + t.net, 0)) }; };
  const avgWin = wins.length ? grossWin / wins.length : null, avgLoss = losses.length ? -grossLoss / losses.length : null;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length, breakeven: trades.length - wins.length - losses.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100, 1) : null,
    net: round(net), grossWin: round(grossWin), grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    avgWin: avgWin === null ? null : round(avgWin), avgLoss: avgLoss === null ? null : round(avgLoss),
    expectancy: trades.length ? round(net / trades.length) : null,
    payoff: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? round(avgWin / Math.abs(avgLoss)) : null,
    maxDrawdown: round(dd),
    bestTrade: trades.length ? round(Math.max(...trades.map((t) => t.net))) : null, worstTrade: trades.length ? round(Math.min(...trades.map((t) => t.net))) : null,
    maxWinStreak: maxW, maxLossStreak: maxL,
    avgHoldMin: hold.length ? round(hold.reduce((a, b) => a + b, 0) / hold.length / 60, 1) : null,
    byHour: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, trades: v.trades, net: round(v.net) })),
    byWeekday: [...days].sort((a, b) => a[0] - b[0]).map(([weekday, v]) => ({ weekday, trades: v.trades, net: round(v.net) })),
    bySide: { buy: side('buy'), sell: side('sell') },
  };
}
