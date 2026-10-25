import type { SessionsSnapshot } from './sessions';
import type { CalendarEvent } from './marketContext';
import type { UserView, AiView } from './views';

/**
 * The morning briefing text. Built only from data the app really has; a section with no data is left out (or says so),
 * never filled with a guess. No AI call: it is deterministic, so it is the same facts every time they are the same.
 */
export interface BriefingInput {
  nowMs: number;
  symbol: string;
  tick: { bid: number; ask: number } | null;
  sessions: SessionsSnapshot | null;
  /** High-impact events for today (already filtered), or null when no calendar is connected. */
  events: CalendarEvent[] | null;
  openPositions: { side: 'buy' | 'sell'; volume: number; sl: number | null; tp: number | null; profit: number }[] | null;
  /** Yesterday's closed trades, from real deals; null = history unavailable. */
  yesterday: { trades: number; net: number; wins: number } | null;
  currency: string;
  myView: UserView | null;
  aiView: AiView | null;
  /** Show money amounts (off when the user keeps balances private). */
  showMoney: boolean;
  tz: string;
}

const hm = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(ms));
const day = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz }).format(new Date(ms));
const money = (n: number, cur: string) => `${n > 0 ? '+' : ''}${n.toFixed(2)} ${cur}`;

export function composeBriefing(i: BriefingInput): string {
  const L: string[] = [`*Good morning. ${day(i.nowMs, i.tz)}*`];
  L.push(i.tick ? `${i.symbol}: ${i.tick.bid.toFixed(2)} / ${i.tick.ask.toFixed(2)}` : `${i.symbol}: no live price (MT5 not connected)`);

  if (i.sessions) {
    const s = i.sessions;
    L.push('', `*Market:* ${s.market.label}`);
    const open = s.sessions.filter((x) => x.active).map((x) => x.name);
    L.push(open.length ? `Open now: ${open.join(', ')}` : 'No session is open right now');
    const next = s.sessions.filter((x) => !x.active && x.nextOpen).sort((a, b) => a.nextOpen! - b.nextOpen!)[0];
    if (next?.nextOpen) L.push(`Next: ${next.name} opens ${hm(next.nextOpen, i.tz)}`);
  }

  L.push('');
  if (i.events === null) L.push('*News:* no economic calendar connected, check it yourself');
  else if (!i.events.length) L.push('*News:* no high-impact events listed for today');
  else { L.push('*High-impact today:*'); for (const e of i.events.slice(0, 6)) L.push(`- ${hm(e.time * 1000, i.tz)} ${e.currency} ${e.title}`); }

  if (i.openPositions) {
    L.push('');
    if (!i.openPositions.length) L.push('*Positions:* none open');
    else {
      L.push(`*Positions:* ${i.openPositions.length} open`);
      for (const p of i.openPositions.slice(0, 5)) L.push(`- ${p.side === 'buy' ? 'Buy' : 'Sell'} ${p.volume} lot, SL ${p.sl ?? 'none'}, TP ${p.tp ?? 'none'}${i.showMoney ? `, ${money(p.profit, i.currency)}` : ''}`);
    }
  }
  if (i.yesterday) {
    L.push('');
    L.push(i.yesterday.trades === 0 ? '*Yesterday:* no closed trades' : `*Yesterday:* ${i.yesterday.trades} trade(s), ${i.yesterday.wins} won${i.showMoney ? `, net ${money(i.yesterday.net, i.currency)}` : ''}`);
  }
  if (i.myView || i.aiView) {
    L.push('');
    if (i.myView) L.push(`*Your view:* ${i.myView.bias} (${i.myView.timeframe})${i.myView.invalidation ? `, invalid if ${i.myView.invalidation}` : ''}`);
    if (i.aiView) L.push(`*AI view:* ${i.aiView.bias}${i.aiView.noSetup ? ', no clean setup' : ''}, ${new Date(i.aiView.savedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (may be old)`);
  }
  L.push('', '_Reply here to ask the AI anything._');
  return L.join('\n');
}
