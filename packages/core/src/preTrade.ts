import { z } from 'zod';
import type { OpenMarketCommand, OpenPendingCommand } from './orderCommand';
import type { GateNumbers } from './riskGate';
import type { RiskSettings } from './settings';
import type { NoTradeWindow } from './marketContext';

/**
 * Pre-trade checklist: a short list shown on the order review page, evaluated from REAL data only.
 * A check passes only when the data to judge it exists; missing data shows "unknown", never "pass".
 * The risk gate stays the only hard limit; this list is what a careful trader asks before pressing Confirm.
 */
export const ManualItemSchema = z.object({ id: z.string().regex(/^[a-z0-9_-]{2,30}$/), label: z.string().min(2).max(120), required: z.boolean().default(false) });
export type ManualItem = z.infer<typeof ManualItemSchema>;

export const ChecklistSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Minimum reward : risk of the first take profit (or the best planned one). */
  minRewardRisk: z.number().positive().max(20).default(1.5),
  /** Session ids a new trade should be in (see sessions settings). Empty = any time. */
  sessions: z.array(z.string()).max(8).default(['london', 'newyork']),
  /** Warn after this many losing trades in a row. */
  streakWarn: z.number().int().min(1).max(10).default(2),
  /** Warn when this share of the daily loss limit is used. */
  dailyWarnPct: z.number().min(10).max(100).default(70),
  /** Your own questions; tick them on the review page. Required ones must be ticked before Confirm. */
  manual: z.array(ManualItemSchema).max(10).default([
    { id: 'htf', label: 'I checked the higher timeframe direction', required: false },
    { id: 'plan', label: 'This trade is part of my plan', required: false },
    { id: 'calm', label: 'I am not chasing a loss', required: false },
  ]),
});
export type ChecklistSettings = z.infer<typeof ChecklistSettingsSchema>;
export const DEFAULT_CHECKLIST: ChecklistSettings = ChecklistSettingsSchema.parse({});

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';
export interface CheckItem { id: string; label: string; status: CheckStatus; detail: string }

export interface ChecklistInput {
  command: OpenMarketCommand | OpenPendingCommand;
  tick: { bid: number; ask: number } | null;
  numbers: GateNumbers;
  risk: Pick<RiskSettings, 'maxRiskPerTradePct' | 'maxSpread'>;
  settings: ChecklistSettings;
  /** Ids of sessions open right now; null = could not be determined. */
  openSessions: string[] | null;
  /** Display names for session ids, for readable messages. */
  sessionNames?: Record<string, string>;
  /** Calendar knowledge: null = no calendar connected (unknown). */
  news: { inWindow: NoTradeWindow | null; next: NoTradeWindow | null } | null;
  /** Losing trades in a row, newest first, from real deals; null = history unavailable. */
  consecutiveLosses: number | null;
  nowMs: number;
}

export interface ChecklistResult {
  items: CheckItem[];
  counts: Record<CheckStatus, number>;
  /** Any fail or warn: the user must tick "I have read these" before Confirm. */
  needsAck: boolean;
  manual: ManualItem[];
}

const f = (n: number, d = 2) => n.toFixed(d);

export function evaluateChecklist(i: ChecklistInput): ChecklistResult {
  const c = i.command, s = i.settings;
  const entry = c.type === 'open_pending' ? c.price : i.tick ? (c.side === 'buy' ? i.tick.ask : i.tick.bid) : null;
  const items: CheckItem[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => items.push({ id, label, status, detail });

  add('sl', 'Stop loss is set', c.sl !== null ? 'pass' : 'fail', c.sl !== null ? `SL ${f(c.sl)}` : 'No stop loss. This is a hard rule for every order.');

  // Reward : risk
  const tps = [c.tp, ...(c.plannedTps ?? []).map((t) => t.price)].filter((p): p is number => p !== null && p !== undefined);
  if (entry === null || c.sl === null) add('rr', `Reward : risk at least ${s.minRewardRisk} : 1`, 'unknown', 'Needs a live price and a stop loss.');
  else if (!tps.length) add('rr', `Reward : risk at least ${s.minRewardRisk} : 1`, 'unknown', 'No take profit is set, so the ratio cannot be judged.');
  else {
    const risk = Math.abs(entry - c.sl);
    const reward = Math.max(...tps.map((p) => Math.abs(p - entry)));
    const ratio = risk > 0 ? reward / risk : 0;
    add('rr', `Reward : risk at least ${s.minRewardRisk} : 1`, ratio >= s.minRewardRisk ? 'pass' : 'fail', `${f(ratio)} : 1 (risk ${f(risk)}, best target ${f(reward)} away)`);
  }

  // Risk size
  add('risk', `Risk per trade within ${i.risk.maxRiskPerTradePct}%`, i.numbers.riskPct === null ? 'unknown' : i.numbers.riskPct <= i.risk.maxRiskPerTradePct + 1e-9 ? 'pass' : 'fail',
    i.numbers.riskPct === null ? 'Risk could not be computed (no balance or contract data).' : `${f(i.numbers.riskPct)}% of the account at the stop`);

  // Spread
  add('spread', 'Spread is acceptable', i.numbers.spread === null ? 'unknown' : i.numbers.spread <= i.risk.maxSpread ? 'pass' : 'fail',
    i.numbers.spread === null ? 'No live spread.' : `${f(i.numbers.spread)} now, limit ${f(i.risk.maxSpread)}`);

  // Session
  const nm = (id: string) => i.sessionNames?.[id] ?? id;
  if (s.sessions.length === 0) add('session', 'Trading in your preferred session', 'pass', 'Any time is allowed in your checklist settings.');
  else if (i.openSessions === null) add('session', 'Trading in your preferred session', 'unknown', 'Session hours could not be read.');
  else {
    const hit = s.sessions.filter((id) => i.openSessions!.includes(id));
    add('session', 'Trading in your preferred session', hit.length ? 'pass' : 'fail',
      hit.length ? `${hit.map(nm).join(' + ')} open` : `Outside ${s.sessions.map(nm).join(' / ')} (open now: ${i.openSessions.length ? i.openSessions.map(nm).join(', ') : 'none'})`);
  }

  // News
  if (i.news === null) add('news', 'No high-impact news around now', 'unknown', 'No economic calendar is connected, so news cannot be checked. Check it yourself.');
  else if (i.news.inWindow) add('news', 'No high-impact news around now', 'fail', `Inside a no-trade window: ${i.news.inWindow.events.map((e) => `${e.title} (${e.currency})`).join(', ')}`);
  else if (i.news.next && i.news.next.start - i.nowMs <= 60 * 60_000) {
    add('news', 'No high-impact news around now', 'warn', `${i.news.next.events[0]?.title ?? 'News'} in ${Math.max(1, Math.round((i.news.next.start - i.nowMs) / 60_000))} min`);
  } else add('news', 'No high-impact news around now', 'pass', 'No qualifying event in the next hour.');

  // Losing streak
  add('streak', 'Not on a losing streak', i.consecutiveLosses === null ? 'unknown' : i.consecutiveLosses >= s.streakWarn ? 'warn' : 'pass',
    i.consecutiveLosses === null ? 'Trade history unavailable.' : i.consecutiveLosses >= s.streakWarn ? `${i.consecutiveLosses} losing trades in a row. Take a break before the next one?` : `${i.consecutiveLosses} losing in a row`);

  // Daily limit
  const used = i.numbers.dailyUsedMoney, limit = i.numbers.dailyLimitMoney;
  if (used === null || limit === null || limit <= 0) add('daily', 'Daily loss limit has room', 'unknown', 'Daily result unknown.');
  else {
    const pct = (Math.max(0, used) / limit) * 100;
    add('daily', 'Daily loss limit has room', pct >= 100 ? 'fail' : pct >= s.dailyWarnPct ? 'warn' : 'pass', `${f(pct, 0)}% of today's loss limit used`);
  }

  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, unknown: 0 };
  for (const it of items) counts[it.status]++;
  return { items, counts, needsAck: counts.fail + counts.warn > 0, manual: s.manual };
}
