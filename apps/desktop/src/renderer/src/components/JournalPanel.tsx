import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw, BookOpen } from 'lucide-react';
import { behaviorFlags, closedTrades, summarize, type BrokerDeal, type AppConfig } from '@aurum/core';
import type { AurumApi, JournalCheckSnapshot } from '../../../shared';
import { Button, EmptyState, Segmented } from './ui';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const money = (n: number | null, cur = '') => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}${cur ? ` ${cur}` : ''}`);
const tone = (n: number | null) => (n === null || n === 0 ? undefined : { color: n > 0 ? 'var(--buy)' : 'var(--sell)' });

/** Journal = the user's real closed trades from MT5 history, with statistics. Nothing here is estimated or sample data. */
export function JournalPanel({ api, config }: { api?: AurumApi; config?: AppConfig | null }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [deals, setDeals] = useState<BrokerDeal[] | null>(null);
  const [checks, setChecks] = useState<Map<number, JournalCheckSnapshot>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    setBusy(true); setErr(null);
    try {
      setDeals(await api.ordersHistory(Number(days)));
      const c = await api.journalChecks().catch(() => []);
      setChecks(new Map(c.flatMap((x) => (x.positionId ? [[x.positionId, x.snapshot] as const] : []))));
    } catch (e) { setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)); setDeals(null); }
    finally { setBusy(false); }
  }, [api, days]);
  useEffect(() => { void load(); }, [load]);

  const trades = useMemo(() => (deals ? closedTrades(deals, config?.brokerSymbol) : []), [deals, config?.brokerSymbol]);
  const s = useMemo(() => summarize(trades), [trades]);
  const flags = useMemo(() => behaviorFlags(trades), [trades]);
  const checkedCount = trades.filter((t) => checks.has(t.positionId)).length;
  const brokeCount = trades.filter((t) => checks.get(t.positionId)?.items.some((i) => i.status === 'fail')).length;

  if (!api) return <EmptyState icon={BookOpen} title="Open the Aurum desktop app to see your journal." />;
  return (
    <div className="journal">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <Segmented<'7' | '30' | '90'> label="Period" size="sm" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        <Button size="sm" icon={RefreshCw} onClick={() => void load()} disabled={busy}>Refresh</Button>
        {busy && <LoaderCircle size={14} className="spin" aria-label="Loading" />}
        <span className="hint">Real closed trades from MT5 ({config?.brokerSymbol ?? 'symbol'}). The EA sends at most the newest 500 deals.</span>
      </div>
      {err && <div className="banner banner-warn" role="status"><span>{err}</span></div>}
      {!err && deals && trades.length === 0 && <EmptyState icon={BookOpen} title="No closed trades in this period." />}
      {trades.length > 0 && (
        <>
          {flags.length > 0 && (
            <section className="flags" aria-label="Behaviour flags">
              <h4>Patterns to look at</h4>
              {flags.map((f) => <div className="flag" key={f.id}><b>{f.title}</b><span className="hint">{f.detail}</span></div>)}
              <span className="hint">These are observations from your real trades, not verdicts. A flagged trade can still have been a good decision.</span>
            </section>
          )}
          {checkedCount > 0 && <div className="hint" data-testid="rules-summary">{brokeCount} of {checkedCount} trades with a saved checklist went ahead with a failed rule.</div>}
          <div className="statgrid" aria-label="Statistics">
            {([
              ['Trades', String(s.trades)], ['Win rate', s.winRate === null ? '—' : `${s.winRate}%`], ['Net', money(s.net, config?.risk ? '' : ''), s.net],
              ['Profit factor', s.profitFactor === null ? '—' : String(s.profitFactor)], ['Expectancy / trade', money(s.expectancy), s.expectancy],
              ['Avg win / loss', `${money(s.avgWin)} / ${money(s.avgLoss)}`], ['Max drawdown', s.maxDrawdown ? `-${s.maxDrawdown.toFixed(2)}` : '0.00'],
              ['Streak (W / L)', `${s.maxWinStreak} / ${s.maxLossStreak}`], ['Avg hold', s.avgHoldMin === null ? '—' : `${s.avgHoldMin} min`],
              ['Buy / Sell net', `${money(s.bySide.buy.net)} / ${money(s.bySide.sell.net)}`],
            ] as [string, string, number?][]).map(([k, v, n]) => (
              <div className="stat" key={k}><span className="l">{k}</span><span className="v mono" style={tone(n ?? null)}>{v}</span></div>
            ))}
          </div>
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>Closed</th><th>Side</th><th>Lots</th><th>Held</th><th>Rules</th><th style={{ textAlign: 'right' }}>Net</th></tr></thead>
              <tbody>
                {[...trades].reverse().slice(0, 100).map((t) => (
                  <tr key={t.positionId}>
                    <td className="mono">{new Date(t.closeTime * 1000).toISOString().slice(5, 16).replace('T', ' ')} {WEEKDAY[new Date(t.closeTime * 1000).getUTCDay()]}</td>
                    <td>{t.side === 'buy' ? 'Buy' : 'Sell'}</td><td className="mono">{t.volume.toFixed(2)}</td>
                    <td className="mono">{t.heldSec === null ? '—' : t.heldSec >= 3600 ? `${(t.heldSec / 3600).toFixed(1)} h` : `${Math.round(t.heldSec / 60)} min`}</td>
                    <RulesCell snap={checks.get(t.positionId)} />
                    <td className="mono" style={{ textAlign: 'right', ...tone(t.net) }}>{money(t.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}


/** Which checklist items did not pass when the trade was confirmed. Trades placed outside Aurum have no checklist. */
function RulesCell({ snap }: { snap: JournalCheckSnapshot | undefined }) {
  if (!snap) return <td className="hint">No checklist</td>;
  const failed = snap.items.filter((i) => i.status === 'fail'), warned = snap.items.filter((i) => i.status === 'warn');
  if (!failed.length && !warned.length) return <td style={{ color: 'var(--buy)' }}>Followed</td>;
  return (
    <td title={[...failed, ...warned].map((i) => i.label).join('\n')}>
      {failed.length > 0 && <span style={{ color: 'var(--sell)' }}>Broke: {failed.map((i) => i.label.replace(/ at least.*| within.*/, '')).join(', ')}</span>}
      {failed.length === 0 && <span style={{ color: 'var(--warn)' }}>Warned: {warned.map((i) => i.label).join(', ')}</span>}
    </td>
  );
}
