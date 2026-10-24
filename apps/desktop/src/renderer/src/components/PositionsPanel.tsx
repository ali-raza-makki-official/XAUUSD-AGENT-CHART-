import { useEffect, useState } from 'react';
import { Briefcase, ShieldAlert } from 'lucide-react';
import { floorToStep } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import type { OrdersState } from '../../../main/orders';
import { Button, Chip, EmptyState } from './ui';

type Open = (body: { type: string } & Record<string, unknown>, extra?: string[]) => void;

export function PositionsPanel({ api, open, onSettings }: { api: AurumApi; open: Open; onSettings: () => void }) {
  const [st, setSt] = useState<OrdersState | null>(null);
  const [edit, setEdit] = useState<{ ticket: number; sl: string; tp: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => api.ordersState().then((s) => alive && setSt(s)).catch(() => undefined);
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
          <thead><tr><th>Ticket</th><th>Side</th><th>Lots</th><th>Open</th><th>SL</th><th>TP</th><th>P/L</th><th /></tr></thead>
          <tbody>
            {st.positions.map((p) => (
              <tr key={p.ticket}>
                <td className="mono">{p.ticket}</td>
                <td style={{ color: p.type === 'buy' ? 'var(--buy)' : 'var(--sell)' }}>{p.type.toUpperCase()}</td>
                <td className="mono">{p.volume.toFixed(2)}</td>
                <td className="mono">{p.priceOpen.toFixed(2)}</td>
                <td className="mono">{p.sl?.toFixed(2) ?? <span className="warn">none</span>}</td>
                <td className="mono">{p.tp?.toFixed(2) ?? '–'}</td>
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
                      <Button size="sm" onClick={() => open({ type: 'modify_sltp', ticket: p.ticket, ticketKind: 'position', sl: p.priceOpen })}>SL to entry</Button>
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
    </div>
  );
}
