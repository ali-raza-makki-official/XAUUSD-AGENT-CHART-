import { PAPER_KEYS, groupStats, rankCombos, type ComboResult, type PaperPath, type PaperTrade } from './paper';

/**
 * What the paper results say. Plain statistics with their sample sizes: small samples are labelled as such and never
 * produce a recommendation. Nothing here changes any setting.
 */
export interface Finding { kind: 'good' | 'bad' | 'info'; text: string; n: number }

const MIN_GROUP = 8;
const finished = (t: PaperTrade) => (t.status === 'won' || t.status === 'lost' || t.status === 'timeout') && t.resultPips !== undefined;
const signed = (v: number) => `${v > 0 ? '+' : ''}${v}`;

export function findings(trades: readonly PaperTrade[]): Finding[] {
  const done = trades.filter(finished);
  if (done.length < MIN_GROUP) return [{ kind: 'info', n: done.length, text: `Only ${done.length} finished paper trade(s) so far. Findings start at ${MIN_GROUP}; recommendations need more.` }];
  const overall = done.reduce((s, t) => s + t.resultPips!, 0) / done.length;
  const out: Finding[] = [{ kind: overall >= 0 ? 'good' : 'bad', n: done.length, text: `Overall: ${signed(Math.round(overall * 10) / 10)} pips per trade over ${done.length} paper trades (${Math.round((done.filter((t) => t.resultPips! > 0).length / done.length) * 100)}% winners).` }];
  const labels: Record<string, string> = { source: 'Ideas from', side: 'Direction', session: 'Session', weekday: 'Day', entry: 'Entry type', rewardRisk: 'Reward:risk', live: 'Trades' };
  for (const [key, fn] of Object.entries(PAPER_KEYS)) {
    for (const g of groupStats(done, fn)) {
      if (g.n < MIN_GROUP || g.expectancy === null) continue;
      const diff = g.expectancy - overall;
      if (Math.abs(diff) < Math.max(10, Math.abs(overall) * 0.5)) continue;
      out.push({ kind: diff > 0 ? 'good' : 'bad', n: g.n, text: `${labels[key] ?? key} "${g.key}": ${signed(g.expectancy)} pips per trade over ${g.n} trades (${g.winRate}% winners), ${diff > 0 ? 'better' : 'worse'} than the average of ${signed(Math.round(overall * 10) / 10)}.` });
    }
  }
  return out;
}

export interface Tuning {
  current: { slPips: number; tpPips: number };
  best: ComboResult;
  /** How the current setting and the best one did on the older 70% (used to choose) and the newer 30% (never used to choose). */
  train: { best: ComboResult; current: ComboResult };
  test: { best: ComboResult; current: ComboResult };
  sample: number;
  /** True only when the sample is large enough AND the choice also beat the current setting on trades it was not picked from. */
  confident: boolean;
  reason: string;
}

export interface TunePath { path: PaperPath; lastPips: number; openedAt: number }

export const SL_GRID = [30, 40, 50, 60, 70, 80, 100, 120, 150];
export const TP_GRID = [50, 70, 100, 140, 200, 300];
export const MIN_TUNE_SAMPLE = 30;

/** Picks the best stop/target pair on the older trades, then checks it against the newer ones. Returns null when there is nothing to compare. */
export function suggestTuning(paths: readonly TunePath[], current: { slPips: number; tpPips: number }, minSample = MIN_TUNE_SAMPLE): Tuning | null {
  if (paths.length < 6) return null;
  const sorted = [...paths].sort((a, b) => a.openedAt - b.openedAt);
  const cut = Math.max(3, Math.floor(sorted.length * 0.7));
  const train = sorted.slice(0, cut), test = sorted.slice(cut);
  const sl = [...new Set([...SL_GRID, current.slPips])].sort((a, b) => a - b), tp = [...new Set([...TP_GRID, current.tpPips])].sort((a, b) => a - b);
  const at = (rows: ComboResult[], c: { slPips: number; tpPips: number }) => rows.find((r) => r.slPips === c.slPips && r.tpPips === c.tpPips)!;
  const trainRank = rankCombos(train, sl, tp);
  const best = trainRank[0]!;
  const testRank = rankCombos(test, sl, tp);
  const all = rankCombos(sorted, sl, tp);
  const t = { best: at(testRank, best), current: at(testRank, current) };
  const tr = { best, current: at(trainRank, current) };
  const sameAsNow = best.slPips === current.slPips && best.tpPips === current.tpPips;
  const enough = sorted.length >= minSample;
  const betterOnTest = t.best.expectancy >= t.current.expectancy + 5 && t.best.expectancy > 0;
  const confident = enough && !sameAsNow && betterOnTest && best.expectancy > tr.current.expectancy;
  const reason = sameAsNow ? 'Your current stop and target are already the best pair on this data.'
    : !enough ? `Only ${sorted.length} trades: need ${minSample} before a recommendation counts. This is a hint, not advice.`
    : !betterOnTest ? 'The best pair on older trades did not clearly beat your current one on the newer trades, so it is not recommended.'
    : `On the older ${train.length} trades ${best.slPips}/${best.tpPips} pips averaged ${best.expectancy} pips; on the newer ${test.length} it averaged ${t.best.expectancy} versus ${t.current.expectancy} for your current ${current.slPips}/${current.tpPips}.`;
  return { current, best: sameAsNow ? at(all, current) : all.find((r) => r.slPips === best.slPips && r.tpPips === best.tpPips)!, train: tr, test: t, sample: sorted.length, confident, reason };
}
