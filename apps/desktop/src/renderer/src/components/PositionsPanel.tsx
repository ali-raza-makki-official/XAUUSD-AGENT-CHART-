import { useEffect, useState } from 'react';
import { Briefcase, ShieldAlert } from 'lucide-react';
import { floorToStep } from '@aurum/core';
import type { AssistPipRow, AurumApi } from '../../../shared';
import type { OrdersState } from '../../../main/orders';
import { Button, Chip, EmptyState } from './ui';

type Open = (body: { type: string } & Record<string, unknown>, extra?: string[]) => void;

export function PositionsPanel({ api, open, onSettings, bePips = 2, pipSize = 0.1 }: { api: AurumApi; open: Open; onSettings: () => void; bePips?: number; pipSize?: number }) {
  const [st, setSt] = useState<OrdersState | null>(null);
  const [edit, setEdit] = useState<{ ticket: number; sl: string; tp: string } | null>(null);
  const [pips, setPips] = useState<Map<number, AssistPipRow>>(new Map());
  const [pform, setPform] = useState<{ orderType: 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop'; price: string; sl: string; tp: string; lots: string; hours: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => { void api.assistPips().then((rows) => alive && setPips(new Map(rows.map((r) => [r.ticket, r])))).catch(() => undefined); return api.ordersState().then((s) => alive && setSt(s)).catch(() => undefined); };
    void tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [api]);

  if (!st) return <EmptyState icon={Briefcase} title="Loading positions…" />;
  const step = st.spec?.volumeStep ?? 0.01;
  const min = st.spec?.volumeMin ?? 0.01;
  const partial = (ticket: number, vol: number, pct: number) => {
    const v = floorToStep((vol * pct) / 100, step);
    if (v < min || v >= vol) return;
    open({ type: 'partial_close', ticket, volume: v });
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        {st.account ? (st.account.demo ? <Chip tone="ai" icon={ShieldAlert}>DEMO · {st.account.server}</Chip> : <Chip tone="gold">LIVE · {st.account.server}</Chip>) : <Chip>No account</Chip>}
        {st.enabled ? <Chip tone="ok">Trading enabled</Chip> : <Chip tone="warn">Trading off</Chip>}
        {st.killSwitch && <Chip tone="danger">AI stopped</Chip>}
        {!st.enabled && <Button size="sm" onClick={onSettings}>Enable in Settings &gt; Trading</Button>}
        {st.error && <span className="hint">{st.error}</span>}
      </div>
      {st.positions.length === 0 ? (
        <EmptyState icon={Briefcase} title="No open positions">Positions opened in MT5 or from Aurum appear here live.</EmptyState>
      ) : (
        <table className="dtable">
          <thead><tr><th>Ticket</th><th>Side</th><th>Lots</th><th>Open</th><th>SL</th><th>TP</th><th>Pips</th><th>SL / TP pips</th><th>P/L</th><th /></tr></thead>
          <tbody>
            {st.positions.map((p) => (
              <tr key={p.ticket}>
                <td className="mono">{p.ticket}</td>
                <td style={{ color: p.type === 'buy' ? 'var(--buy)' : 'var(--sell)' }}>{p.type.toUpperCase()}</td>
                <td className="mono">{p.volume.toFixed(2)}</td>
                <td className="mono">{p.priceOpen.toFixed(2)}</td>
                <td className="mono">{p.sl?.toFixed(2) ?? <span className="warn">none</span>}</td>
                <td className="mono">{p.tp?.toFixed(2) ?? '–'}</td>
                <td className="mono" style={{ color: (pips.get(p.ticket)?.pips ?? 0) >= 0 ? 'var(--buy)' : 'var(--sell)' }} data-testid="pos-pips">{pips.get(p.ticket)?.pips === null || pips.get(p.ticket) === undefined ? '–' : `${(pips.get(p.ticket)!.pips! > 0 ? '+' : '')}${pips.get(p.ticket)!.pips!.toFixed(1)}`}</td>
                <td className="mono hint">{(() => { const v = pips.get(p.ticket)?.slPips; return v === null || v === undefined ? 'no stop' : v >= 0 ? `locked +${v}` : `risk ${Math.abs(v)}`; })()} / {pips.get(p.ticket)?.tpPips ?? '–'}</td>
                <td className="mono" style={{ color: p.profit >= 0 ? 'var(--buy)' : 'var(--sell)' }}>{p.profit.toFixed(2)}</td>
                <td>
                  {edit?.ticket === p.ticket ? (
                    <span className="row">
                      <input className="input mono" style={{ width: 84 }} aria-label="New SL" placeholder="SL" value={edit.sl} onChange={(e) => setEdit({ ...edit, sl: e.target.value })} />
                      <input className="input mono" style={{ width: 84 }} aria-label="New TP" placeholder="TP" value={edit.tp} onChange={(e) => setEdit({ ...edit, tp: e.target.value })} />
                      <Button size="sm" variant="primary" onClick={() => {
                        const sl = edit.sl.trim() === '' ? undefined : Number(edit.sl); const tp = edit.tp.trim() === '' ? undefined : Number(edit.tp);
                        if ((sl !== undefined && !(sl > 0)) || (tp !== undefined && !(tp > 0)) || (sl === undefined && tp === undefined)) return;
                        open({ type: 'modify_sltp', ticket: p.ticket, ticketKind: 'position', ...(sl !== undefined ? { sl } : {}), ...(tp !== undefined ? { tp } : {}) });
                        setEdit(null);
                      }}>Review</Button>
                      <Button size="sm" onClick={() => setEdit(null)}>Cancel</Button>
                    </span>
                  ) : (
                    <span className="row">
                      <Button size="sm" onClick={() => open({ type: 'modify_sltp', ticket: p.ticket, ticketKind: 'position', sl: Math.round((p.type === 'buy' ? p.priceOpen + bePips * pipSize : p.priceOpen - bePips * pipSize) * 100) / 100 })}>Breakeven +{bePips}p</Button>
                      <Button size="sm" onClick={() => setEdit({ ticket: p.ticket, sl: p.sl?.toString() ?? '', tp: p.tp?.toString() ?? '' })}>SL/TP</Button>
                      <Button size="sm" onClick={() => partial(p.ticket, p.volume, 25)}>25%</Button>
                      <Button size="sm" onClick={() => partial(p.ticket, p.volume, 50)}>50%</Button>
                      <Button size="sm" variant="danger" onClick={() => open({ type: 'close_position', ticket: p.ticket })}>Close</Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className="subhead">Pending orders</h4>
      {st.orders.length === 0 ? <span className="hint">No pending orders.</span> : (
        <table className="dtable">
          <thead><tr><th>Ticket</th><th>Type</th><th>Lots</th><th>Price</th><th>SL</th><th>TP</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {st.orders.map((o) => (
              <tr key={o.ticket}>
                <td className="mono">{o.ticket}</td>
                <td>{o.type.replace('_', ' ')}</td>
                <td className="mono">{o.volume.toFixed(2)}</td>
                <td className="mono">{o.priceOpen.toFixed(2)}</td>
                <td className="mono">{o.sl?.toFixed(2) ?? <span className="warn">none</span>}</td>
                <td className="mono">{o.tp?.toFixed(2) ?? '–'}</td>
                <td className="mono">{o.expiration ? new Date(o.expiration * 1000).toISOString().slice(5, 16).replace('T', ' ') : 'until cancelled'}</td>
                <td><Button size="sm" variant="danger" onClick={() => open({ type: 'cancel_pending', ticket: o.ticket })}>Cancel order</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!pform ? (
        <div style={{ marginTop: 8 }}><Button size="sm" disabled={!st.enabled} onClick={() => setPform({ orderType: 'buy_limit', price: '', sl: '', tp: '', lots: String(min), hours: '' })}>New pending order</Button></div>
      ) : (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <select className="input" aria-label="Pending order type" value={pform.orderType} onChange={(e) => setPform({ ...pform, orderType: e.target.value as typeof pform.orderType })}>
            {(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'] as const).map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
          {([['price', 'Entry price'], ['sl', 'SL (required)'], ['tp', 'TP'], ['lots', 'Lots'], ['hours', 'Expires in hours']] as const).map(([k, label]) => (
            <input key={k} className="input mono" style={{ width: 118 }} inputMode="decimal" aria-label={label} placeholder={label} value={pform[k]} onChange={(e) => setPform({ ...pform, [k]: e.target.value })} />
          ))}
          <Button size="sm" variant="primary" onClick={() => {
            const price = Number(pform.price), sl = Number(pform.sl), vol = Number(pform.lots), tp = pform.tp.trim() === '' ? null : Number(pform.tp), hrs = pform.hours.trim() === '' ? null : Number(pform.hours);
            if (!(price > 0) || !(sl > 0) || !(vol > 0) || (tp !== null && !(tp > 0)) || (hrs !== null && !(hrs > 0))) return;
            open({ type: 'open_pending', orderType: pform.orderType, price, volume: vol, sl, tp, ...(hrs ? { expiration: Math.floor(Date.now() / 1000) + Math.round(hrs * 3600) } : {}) });
            setPform(null);
          }}>Review</Button>
          <Button size="sm" onClick={() => setPform(null)}>Close</Button>
        </div>
      )}
    </div>
  );
}
