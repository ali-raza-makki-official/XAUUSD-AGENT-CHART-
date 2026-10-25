import type { AiPermissions, RiskSettings } from './settings';
import type { ContractSpec } from './risk';
import { isValidVolume, riskAtSl, slMoveAllowedAfterLimit } from './orders';
import { isValidTimeZone, localParts, zonedTimeToUtc } from './timezone';
import {
  isOpening, type AnyOrderCommand, type BrokerDeal, type BrokerOrder, type BrokerPosition, type ModifySltpCommand, type OpenMarketCommand, type OpenPendingCommand,
} from './orderCommand';

/**
 * The deterministic RiskGate. Pure function of its input: same input, same verdict, no clock, no I/O, no LLM.
 * It runs twice for every order: once for the PREVIEW (so the user sees why something would be refused) and
 * again immediately before sending, with a fresh broker snapshot.
 */

export type GateRule =
  | 'trading_disabled' | 'account_unknown' | 'live_blocked' | 'symbol_not_allowed' | 'actor_not_permitted' | 'kill_switch'
  | 'ai_suggest_only' | 'ai_automatic_disabled' | 'ai_permission_missing' | 'bulk_close_permission' | 'not_confirmed' | 'command_expired'
  | 'unresolved_command' | 'no_quote' | 'stale_quote' | 'no_spec' | 'volume_invalid' | 'missing_sl' | 'sl_wrong_side' | 'tp_wrong_side' | 'max_spread' | 'max_slippage'
  | 'max_positions' | 'per_trade_risk' | 'open_risk' | 'daily_limit_unknown' | 'daily_limit_hit' | 'daily_limit_would_exceed' | 'daily_limit_frozen'
  | 'assistant_off' | 'plan_not_approved' | 'rule_not_allowed' | 'rule_widens_risk'
  | 'sl_widen_after_limit' | 'sl_widen_exceeds_trade_risk' | 'position_not_found' | 'order_not_found' | 'partial_volume_invalid' | 'nothing_to_close';

export interface GateCheck { rule: GateRule; message: string }

export interface GateInput {
  command: AnyOrderCommand;
  now: number;
  /** True only after the user pressed Confirm in the UI for exactly this command. Required for EVERY actor. */
  userConfirmed: boolean;
  settings: {
    tradingEnabled: boolean;
    risk: RiskSettings;
    aiPermissions: AiPermissions;
    /** Broker symbols that may be traded. Must also look like gold. */
    allowedSymbols: string[];
    /** Trade Assistant: the master switch and the ids of plans the user approved. Absent = assistant off. */
    assistant?: { enabled: boolean; approvedPlanIds: string[] };
    /** Never true in the app in this iteration (AURUM_ALLOW_LIVE is not set by Aurum). */
    allowLive: boolean;
  };
  killSwitch: boolean;
  account: { demo: boolean; balance: number; equity?: number; currency: string } | null;
  spec: (ContractSpec & { point?: number }) | null;
  /** ageMs = how long ago the price last changed (local clock). Absent = freshness unknown, which only tests do. */
  tick: { bid: number; ask: number; ageMs?: number } | null;
  positions: BrokerPosition[];
  orders: BrokerOrder[];
  /** Realised result since the daily reset (profit + commission + swap + fees), negative = loss. null = unknown. */
  dailyRealizedPnl: number | null;
  /** Commands in unknown_reconcile (type + ticket they touch). */
  unresolved: { commandId: string; type: string; ticket: number | null }[];
}

export interface GateNumbers {
  riskMoney: number | null;
  riskPct: number | null;
  openRiskMoney: number | null;
  openRiskPct: number | null;
  dailyStartBalance: number | null;
  dailyLimitMoney: number | null;
  dailyUsedMoney: number | null;
  dailyLimitHit: boolean | null;
  spread: number | null;
  positions: number;
  pendingOrders: number;
}

export interface GateResult {
  ok: boolean;
  /** The FIRST rule that failed, in a fixed order. null when ok. */
  failed: GateCheck | null;
  failures: GateCheck[];
  warnings: string[];
  numbers: GateNumbers;
}

/** A price that has not changed for this long is not trusted for opening trades. */
export const MAX_QUOTE_AGE_MS = 60_000;
const EPS = 1e-9;
const GOLD = /(XAU|GOLD)/i;
const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'unlimited');

/** Does the symbol look like gold and is it on the allow-list? (XAUUSD-style and GOLD-style names.) */
export const isAllowedSymbol = (symbol: string, allowed: string[]) => GOLD.test(symbol) && allowed.includes(symbol);

/** Sum of realised results since `sinceSec` (broker server clock). Only buy/sell deals count, not deposits. */
export function realizedPnlSince(deals: BrokerDeal[], sinceSec: number): number {
  let sum = 0;
  for (const d of deals) {
    if ((d.type !== 'buy' && d.type !== 'sell') || d.time < sinceSec) continue;
    sum += d.profit + d.commission + d.swap + d.fee;
  }
  return Math.round(sum * 100) / 100;
}

/**
 * Start of the current risk day on the BROKER SERVER clock (the scale MT5 deals and ticks use), as unix seconds.
 * tz 'broker' = server midnight. Otherwise local midnight in the IANA zone, translated by elapsed time.
 * null when it cannot be known (no server time yet); callers must then fail closed for new risk.
 */
export function dailyWindowStart(nowMs: number, tz: string, serverNowSec: number | null): number | null {
  if (serverNowSec === null || !Number.isFinite(serverNowSec) || serverNowSec <= 0) return null;
  if (tz === 'broker' || !isValidTimeZone(tz)) return Math.floor(serverNowSec / 86400) * 86400;
  const p = localParts(nowMs, tz);
  const startUtc = zonedTimeToUtc(p.y, p.m, p.d, 0, 0, tz);
  return serverNowSec - (nowMs - startUtc) / 1000;
}

/** Smallest valid partial-close problem description, or null when volume is fine. */
export function partialVolumeProblem(positionVolume: number, volume: number, spec: ContractSpec): string | null {
  if (!isValidVolume(volume, spec)) return `Volume ${volume} is not valid for this broker (min ${spec.volumeMin}, step ${spec.volumeStep}).`;
  if (volume >= positionVolume - 1e-12) return `A partial close must be smaller than the position (${positionVolume} lot). Use a full close instead.`;
  const remainder = Math.round((positionVolume - volume) * 1e8) / 1e8;
  if (remainder < spec.volumeMin - 1e-12) return `Closing ${volume} would leave ${remainder} lot, below the broker minimum ${spec.volumeMin}.`;
  return null;
}

const OWN_AI_MESSAGE = {
  ai_suggest_only: 'AI order mode is "suggest": the AI can only show previews. Press the order buttons yourself, or set the mode to "confirm" in Settings > AI.',
  ai_automatic_disabled: 'Automatic AI order execution is disabled in this version.',
};

export function evaluateGate(inp: GateInput): GateResult {
  const { command: c, settings: s } = inp;
  const failures: GateCheck[] = [];
  const warnings: string[] = [];
  const fail = (rule: GateRule, message: string) => { failures.push({ rule, message }); };
  const numbers: GateNumbers = {
    riskMoney: null, riskPct: null, openRiskMoney: null, openRiskPct: null, dailyStartBalance: null, dailyLimitMoney: null,
    dailyUsedMoney: null, dailyLimitHit: null, spread: null, positions: inp.positions.length, pendingOrders: inp.orders.length,
  };
  const done = (): GateResult => ({ ok: failures.length === 0, failed: failures[0] ?? null, failures, warnings, numbers });

  // 1. switches, account, identity
  if (!s.tradingEnabled) fail('trading_disabled', 'Trading is switched off in Settings > Trading.');
  if (!inp.account) fail('account_unknown', 'No MT5 account information yet. Connect MT5 first.');
  else if (!inp.account.demo && !s.allowLive) fail('live_blocked', 'This is a LIVE account. Aurum refuses to trade live accounts in this version.');
  if (!isAllowedSymbol(c.symbol, s.allowedSymbols)) fail('symbol_not_allowed', `${c.symbol} is not allowed. Only the configured gold symbol can be traded.`);
  if (c.actor === 'whatsapp') fail('actor_not_permitted', 'Orders from WhatsApp are not enabled in this version.');
  if (c.actor === 'ai') {
    if (inp.killSwitch) fail('kill_switch', '"Stop AI actions" is on: AI-origin commands are blocked. Resume the AI first.');
    const mode = s.aiPermissions.orders;
    if (mode === 'suggest') fail('ai_suggest_only', OWN_AI_MESSAGE.ai_suggest_only);
    else if (mode === 'automatic') fail('ai_automatic_disabled', OWN_AI_MESSAGE.ai_automatic_disabled);
    else if (c.type === 'close_all') {
      if (!s.aiPermissions.bulkClose) fail('bulk_close_permission', 'The AI has no permission for bulk close (Settings > AI). Close all is a separate permission.');
    } else if (!isOpening(c) && !s.aiPermissions.sltpAndPartialClose) {
      fail('ai_permission_missing', 'The AI has no permission to modify SL/TP or close positions (Settings > AI).');
    }
  }
  if (c.actor === 'rule') {
    // The assistant only acts inside what the user approved beforehand: a named plan to open, or risk-reducing management.
    if (inp.killSwitch) fail('kill_switch', '"Stop AI actions" is on: the assistant is paused.');
    if (!s.assistant?.enabled) fail('assistant_off', 'The Trade Assistant is switched off (Settings > Trading > Assistant).');
    if (isOpening(c)) {
      const planId = (c as OpenMarketCommand | OpenPendingCommand).planId;
      if (!planId || !(s.assistant?.approvedPlanIds ?? []).includes(planId)) fail('plan_not_approved', 'This order does not belong to a plan you approved.');
    } else if (c.type === 'modify_sltp') {
      const m = c as ModifySltpCommand;
      if (m.ticketKind !== 'position' || m.sl === undefined || m.sl === null || m.tp !== undefined) fail('rule_not_allowed', 'The assistant may only move a position\'s stop loss, never remove it or change take profit.');
      else {
        const p = inp.positions.find((x) => x.ticket === m.ticket);
        if (p && p.sl !== null && (p.type === 'buy' ? m.sl <= p.sl : m.sl >= p.sl)) fail('rule_widens_risk', 'The assistant may only move a stop loss toward profit, never back.');
      }
    } else if (c.type !== 'partial_close' && c.type !== 'close_position') fail('rule_not_allowed', `The assistant is not allowed to run "${c.type}".`);
  }
  if (!inp.userConfirmed) fail('not_confirmed', 'The user has not confirmed this exact command.');
  if (inp.now >= c.expiresAt) fail('command_expired', 'This command expired before it was confirmed. Prepare it again.');

  // 2. unresolved earlier commands: no new risk, and nothing on the same ticket
  const ticket = 'ticket' in c ? c.ticket : null;
  const blockers = inp.unresolved.filter((u) => u.commandId !== c.commandId);
  if (blockers.length && isOpening(c)) fail('unresolved_command', `Command ${blockers[0]!.commandId} has an unknown result. Reconcile it with MT5 before opening anything new.`);
  else if (ticket !== null && blockers.some((u) => u.ticket === ticket)) fail('unresolved_command', `An earlier command on #${ticket} has an unknown result. Reconcile it first.`);

  const spec = inp.spec;
  const risk = s.risk;
  const balance = inp.account?.balance ?? null;
  const isLimitHit = (() => {
    if (balance === null) return null;
    if (inp.dailyRealizedPnl === null) return null;
    const start = balance - inp.dailyRealizedPnl;
    const limit = (start * risk.maxDailyLossPct) / 100;
    const floating = inp.positions.reduce((a, p) => a + p.profit + p.swap, 0);
    const used = Math.max(0, -inp.dailyRealizedPnl) + (risk.countFloatingInDailyLimit ? Math.max(0, -floating) : 0);
    numbers.dailyStartBalance = start; numbers.dailyLimitMoney = limit; numbers.dailyUsedMoney = used;
    numbers.dailyLimitHit = used >= limit - EPS;
    return numbers.dailyLimitHit;
  })();

  if (c.type === 'close_all') {
    if (inp.positions.length === 0) fail('nothing_to_close', 'There are no open positions to close.');
    return done();
  }

  // 3. per command rules
  if (isOpening(c)) {
    const o = c as OpenMarketCommand | OpenPendingCommand;
    const side = o.type === 'open_market' ? o.side : o.orderType.startsWith('buy') ? 'buy' : 'sell';
    if (!spec) fail('no_spec', 'The broker contract specification is not available yet.');
    if (balance === null || !(balance > 0)) fail('account_unknown', 'Account balance is not available.');
    if (spec && !isValidVolume(o.volume, spec)) fail('volume_invalid', `Volume ${o.volume} is not valid for this broker (min ${spec.volumeMin}, max ${spec.volumeMax}, step ${spec.volumeStep}).`);
    if (o.sl === null) {
      if (risk.missingSlPolicy === 'block') fail('missing_sl', 'A stop loss is required (missing-SL policy: block).');
      else warnings.push('No stop loss: this position has unlimited risk.');
    }
    let entry: number | null = null;
    if (o.type === 'open_market') {
      if (!inp.tick) fail('no_quote', 'No live quote. Cannot check spread or price.');
      else {
        entry = side === 'buy' ? inp.tick.ask : inp.tick.bid;
        const spread = inp.tick.ask - inp.tick.bid;
        numbers.spread = spread;
        if (inp.tick.ageMs !== undefined && inp.tick.ageMs > MAX_QUOTE_AGE_MS) fail('stale_quote', `The last price is ${Math.round(inp.tick.ageMs / 1000)} s old (market closed or the feed is frozen). New orders are blocked until prices move again.`);
        if (spread > risk.maxSpread + EPS) fail('max_spread', `Spread ${spread.toFixed(2)} is above your maximum ${risk.maxSpread.toFixed(2)}.`);
      }
      if (spec) {
        const point = spec.point ?? spec.tickSize;
        const dev = o.deviationPoints * point;
        if (dev > risk.maxSlippage + EPS) fail('max_slippage', `Allowed slippage ${dev.toFixed(2)} is above your maximum ${risk.maxSlippage.toFixed(2)}.`);
      }
    } else {
      entry = o.price;
      if (inp.tick?.ageMs !== undefined && inp.tick.ageMs > MAX_QUOTE_AGE_MS) fail('stale_quote', 'The price feed is frozen (no price change for over a minute). New orders are blocked until prices move again.');
    }
    if (entry !== null) {
      const ref = entry;
      if (o.sl !== null && (side === 'buy' ? !(o.sl < ref) : !(o.sl > ref))) fail('sl_wrong_side', `For a ${side} the stop loss must be ${side === 'buy' ? 'below' : 'above'} the entry ${ref.toFixed(2)}.`);
      if (o.tp !== null && (side === 'buy' ? !(o.tp > ref) : !(o.tp < ref))) fail('tp_wrong_side', `For a ${side} the take profit must be ${side === 'buy' ? 'above' : 'below'} the entry ${ref.toFixed(2)}.`);
    }
    if (spec && balance && entry !== null) {
      const newRisk = riskAtSl(spec, side, entry, o.sl, o.volume);
      if (Number.isFinite(newRisk)) {
        numbers.riskMoney = newRisk; numbers.riskPct = (newRisk / balance) * 100;
        if (numbers.riskPct > risk.maxRiskPerTradePct + 1e-9) fail('per_trade_risk', `Risk ${numbers.riskPct.toFixed(2)}% (${fmt(newRisk)}) is above your per-trade maximum ${risk.maxRiskPerTradePct}%.`);
      }
      // total open risk including this order
      let existing = 0;
      let unbounded: string | null = null;
      const foreign = [...inp.positions.map((p) => ({ k: `position #${p.ticket}`, s: p.symbol })), ...inp.orders.map((x) => ({ k: `pending order #${x.ticket}`, s: x.symbol }))].find((x) => x.s && !isAllowedSymbol(x.s, s.allowedSymbols));
      if (foreign) fail('open_risk', `${foreign.k} is on ${foreign.s}, whose risk Aurum cannot value (only ${s.allowedSymbols.join(', ')} is configured). New risk is blocked until it is closed.`);
      for (const p of inp.positions) {
        const r = riskAtSl(spec, p.type, p.priceOpen, p.sl, p.volume);
        if (!Number.isFinite(r)) unbounded = unbounded ?? `position #${p.ticket}`; else existing += r;
      }
      for (const od of inp.orders) {
        const side2 = od.type.startsWith('buy') ? 'buy' : 'sell';
        const r = riskAtSl(spec, side2, od.priceOpen, od.sl, od.volume);
        if (!Number.isFinite(r)) unbounded = unbounded ?? `pending order #${od.ticket}`; else existing += r;
      }
      const total = existing + (Number.isFinite(newRisk) ? newRisk : 0);
      numbers.openRiskMoney = total; numbers.openRiskPct = (total / balance) * 100;
      if (unbounded) fail('open_risk', `${unbounded} has no stop loss, so your total open risk is unbounded. Fix it before opening more.`);
      else if (numbers.openRiskPct > risk.maxOpenRiskPct + 1e-9) fail('open_risk', `Total open risk would be ${numbers.openRiskPct.toFixed(2)}% (${fmt(total)}), above your maximum ${risk.maxOpenRiskPct}%.`);
      // daily limit: hit, or would be exceeded by the worst case of this order
      if (numbers.dailyLimitHit) fail('daily_limit_hit', `Daily loss limit reached (${fmt(numbers.dailyUsedMoney ?? 0)} of ${fmt(numbers.dailyLimitMoney ?? 0)}). New orders are blocked.`);
      else if (numbers.dailyLimitMoney !== null && Number.isFinite(newRisk) && (numbers.dailyUsedMoney ?? 0) + newRisk > numbers.dailyLimitMoney + EPS) {
        fail('daily_limit_would_exceed', `This order's risk ${fmt(newRisk)} plus today's loss ${fmt(numbers.dailyUsedMoney ?? 0)} would exceed the daily limit ${fmt(numbers.dailyLimitMoney)}.`);
      }
    }
    if (isLimitHit === true && !failures.some((f) => f.rule === 'daily_limit_hit')) fail('daily_limit_hit', `Daily loss limit reached (${fmt(numbers.dailyUsedMoney ?? 0)} of ${fmt(numbers.dailyLimitMoney ?? 0)}). New orders are blocked.`);
    if (isLimitHit === null) fail('daily_limit_unknown', 'Today\'s loss could not be determined (no deal history / server time). New risk is blocked until it can.');
    if (inp.positions.length + inp.orders.length + 1 > risk.maxSimultaneousPositions) fail('max_positions', `Max ${risk.maxSimultaneousPositions} simultaneous positions/orders (you have ${inp.positions.length} open and ${inp.orders.length} pending).`);
    return done();
  }

  if (c.type === 'modify_sltp') return modifyRules(c, inp, numbers, warnings, fail, isLimitHit, done);

  if (c.type === 'close_position' || c.type === 'partial_close') {
    const p = inp.positions.find((x) => x.ticket === c.ticket);
    if (!p) fail('position_not_found', `Position #${c.ticket} was not found (already closed?).`);
    else if (p.symbol && !isAllowedSymbol(p.symbol, s.allowedSymbols)) fail('symbol_not_allowed', `Position #${c.ticket} is on ${p.symbol}, not the configured gold symbol. Aurum only manages gold.`);
    else if (c.type === 'partial_close') {
      if (!spec) fail('no_spec', 'The broker contract specification is not available yet.');
      else {
        const problem = partialVolumeProblem(p.volume, c.volume, spec);
        if (problem) fail('partial_volume_invalid', problem);
      }
    }
    return done();
  }

  // cancel_pending
  const cancel = c as { ticket: number };
  const cord = inp.orders.find((x) => x.ticket === cancel.ticket);
  if (!cord) fail("order_not_found", `Pending order #${cancel.ticket} was not found.`);
  else if (cord.symbol && !isAllowedSymbol(cord.symbol, s.allowedSymbols)) fail('symbol_not_allowed', `Pending order #${cancel.ticket} is on ${cord.symbol}, not the configured gold symbol.`);
  return done();
}

function modifyRules(
  c: ModifySltpCommand, inp: GateInput, numbers: GateNumbers, warnings: string[], fail: (r: GateRule, m: string) => void,
  limitHit: boolean | null, done: () => GateResult,
): GateResult {
  const { risk } = inp.settings;
  const spec = inp.spec;
  let side: 'buy' | 'sell';
  let open: number;
  let volume: number;
  let oldSl: number | null;
  let ref: number | null;
  if (c.ticketKind === 'position') {
    const p = inp.positions.find((x) => x.ticket === c.ticket);
    if (!p) { fail('position_not_found', `Position #${c.ticket} was not found (already closed?).`); return done(); }
    if (p.symbol && !isAllowedSymbol(p.symbol, inp.settings.allowedSymbols)) { fail('symbol_not_allowed', `Position #${c.ticket} is on ${p.symbol}, not the configured gold symbol.`); return done(); }
    side = p.type; open = p.priceOpen; volume = p.volume; oldSl = p.sl;
    ref = inp.tick ? (side === 'buy' ? inp.tick.bid : inp.tick.ask) : null;
  } else {
    const o = inp.orders.find((x) => x.ticket === c.ticket);
    if (!o) { fail('order_not_found', `Pending order #${c.ticket} was not found.`); return done(); }
    if (o.symbol && !isAllowedSymbol(o.symbol, inp.settings.allowedSymbols)) { fail('symbol_not_allowed', `Pending order #${c.ticket} is on ${o.symbol}, not the configured gold symbol.`); return done(); }
    side = o.type.startsWith('buy') ? 'buy' : 'sell'; open = o.priceOpen; volume = o.volume; oldSl = o.sl; ref = o.priceOpen;
  }
  const newSl = c.sl === undefined ? oldSl : c.sl;
  if (c.sl === null && risk.missingSlPolicy === 'block') fail('missing_sl', 'Removing the stop loss is blocked (missing-SL policy: block).');
  else if (c.sl === null) warnings.push('The stop loss would be removed: unlimited risk.');
  if (ref !== null) {
    if (c.sl != null && (side === 'buy' ? !(c.sl < ref) : !(c.sl > ref))) fail('sl_wrong_side', `For a ${side} the stop loss must be ${side === 'buy' ? 'below' : 'above'} the current price ${ref.toFixed(2)}.`);
    if (c.tp != null && (side === 'buy' ? !(c.tp > ref) : !(c.tp < ref))) fail('tp_wrong_side', `For a ${side} the take profit must be ${side === 'buy' ? 'above' : 'below'} the current price ${ref.toFixed(2)}.`);
  } else if (c.ticketKind === 'position') fail('no_quote', 'No live quote. Cannot check the new levels.');
  if (c.sl !== undefined && spec && inp.account) {
    const before = riskAtSl(spec, side, open, oldSl, volume);
    const after = riskAtSl(spec, side, open, newSl, volume);
    if (Number.isFinite(after)) { numbers.riskMoney = after; numbers.riskPct = (after / inp.account.balance) * 100; }
    const widens = after > before + 1e-9;
    if (limitHit && risk.dailyLimitPolicy === 'freeze') fail('daily_limit_frozen', 'The daily loss limit is reached and the policy is "freeze": SL/TP changes are blocked. Closing is still allowed.');
    else if (limitHit && !slMoveAllowedAfterLimit(spec, side, open, volume, oldSl, newSl)) {
      fail('sl_widen_after_limit', 'The daily loss limit is reached: moving the stop further away (more risk) is blocked. Moving it toward safety is allowed.');
    } else if (widens && Number.isFinite(after) && numbers.riskPct !== null && numbers.riskPct > risk.maxRiskPerTradePct + 1e-9) {
      fail('sl_widen_exceeds_trade_risk', `The new stop risks ${numbers.riskPct.toFixed(2)}% of balance, above your per-trade maximum ${risk.maxRiskPerTradePct}%.`);
    }
    if (widens && Number.isFinite(after) && inp.account.balance > 0) {
      // the new stop must also fit the TOTAL open-risk budget, not only the per-trade one
      let others = 0;
      for (const p of inp.positions) if (!(c.ticketKind === 'position' && p.ticket === c.ticket)) { const r = riskAtSl(spec, p.type, p.priceOpen, p.sl, p.volume); if (Number.isFinite(r)) others += r; }
      for (const od of inp.orders) if (!(c.ticketKind === 'order' && od.ticket === c.ticket)) { const r = riskAtSl(spec, od.type.startsWith('buy') ? 'buy' : 'sell', od.priceOpen, od.sl, od.volume); if (Number.isFinite(r)) others += r; }
      const totalPct = ((others + after) / inp.account.balance) * 100;
      numbers.openRiskMoney = others + after; numbers.openRiskPct = totalPct;
      if (totalPct > risk.maxOpenRiskPct + 1e-9) fail('open_risk', `The new stop would raise total open risk to ${totalPct.toFixed(2)}%, above your maximum ${risk.maxOpenRiskPct}%.`);
    }
    if (limitHit === null && widens) fail('daily_limit_unknown', 'Today\'s loss is unknown, so a stop that increases risk is blocked.');
  } else if (c.sl !== undefined && limitHit && risk.dailyLimitPolicy === 'freeze') {
    fail('daily_limit_frozen', 'The daily loss limit is reached and the policy is "freeze".');
  } else if (c.sl !== undefined && !spec) fail('no_spec', 'The broker contract specification is not available yet.');
  if (c.sl === undefined && c.tp !== undefined && limitHit && risk.dailyLimitPolicy === 'freeze') fail('daily_limit_frozen', 'The daily loss limit is reached and the policy is "freeze": SL/TP changes are blocked.');
  return done();
}
