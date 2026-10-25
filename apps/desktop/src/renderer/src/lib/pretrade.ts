import {
  closedTrades, evaluateChecklist, inNoTradeWindow, isOpening, nextNoTradeWindow, noTradeWindows,
  type AppConfig, type CalendarEvent, type ChecklistResult, type OpenMarketCommand, type OpenPendingCommand, type PrepareResult,
} from '@aurum/core';
import type { AurumApi } from '../../../shared';

type Prepared = Extract<PrepareResult, { ok: true; executable: boolean }>;

/** Losing trades in a row, newest first, from real closed deals. null = history could not be read. */
export function consecutiveLosses(deals: Parameters<typeof closedTrades>[0]): number {
  let n = 0;
  for (const t of [...closedTrades(deals)].reverse()) { if (t.net < 0) n++; else break; }
  return n;
}

/**
 * Collects the real data the checklist needs (sessions, calendar, history) and evaluates it.
 * Anything that cannot be read becomes "unknown" in the list instead of being guessed.
 * Returns null for commands that do not open risk (closing, moving a stop) or when the checklist is turned off.
 */
export async function gatherChecklist(api: AurumApi, config: AppConfig, p: Prepared, tick: { bid: number; ask: number } | null): Promise<ChecklistResult | null> {
  const cmd = p.command;
  if (!config.checklist.enabled || !isOpening(cmd)) return null;
  const nowMs = Date.now();
  const [sessions, calendar, deals] = await Promise.all([
    api.contextRead('sessions').catch(() => null),
    api.contextRead('calendar').catch(() => null),
    api.ordersHistory(2).catch(() => null),
  ]);

  let openSessions: string[] | null = null; const sessionNames: Record<string, string> = {};
  if (sessions && sessions.ok) {
    openSessions = sessions.data.sessions.filter((s) => s.active).map((s) => s.id);
    for (const s of sessions.data.sessions) sessionNames[s.id] = s.name;
  }

  let news: { inWindow: ReturnType<typeof inNoTradeWindow>; next: ReturnType<typeof nextNoTradeWindow> } | null = null;
  const good = (calendar ?? []).filter((c) => c.result.ok);
  if (good.length) {
    const events: CalendarEvent[] = good.flatMap((c) => (c.result.ok ? c.result.data.items : []));
    const windows = noTradeWindows(events, config.context.noTrade);
    news = { inWindow: inNoTradeWindow(windows, nowMs), next: nextNoTradeWindow(windows, nowMs) };
  }

  return evaluateChecklist({
    command: cmd as OpenMarketCommand | OpenPendingCommand,
    tick,
    numbers: p.gate.numbers, risk: config.risk, settings: config.checklist,
    openSessions, sessionNames, news, consecutiveLosses: deals ? consecutiveLosses(deals) : null, nowMs,
  });
}
