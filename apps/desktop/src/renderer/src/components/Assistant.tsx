import { useCallback, useEffect, useState } from 'react';
import { Bot, CircleHelp, Crosshair, X } from 'lucide-react';
import { fmtPips, type TradePlan } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, Chip, EmptyState, IconButton, Segmented, type Tone } from './ui';

const STATUS: Record<TradePlan['status'], { tone: Tone; text: string }> = {
  proposed: { tone: 'warn', text: 'Needs your approval' }, armed: { tone: 'ok', text: 'Watching the zone' }, asking: { tone: 'gold', text: 'Zone reached: your answer' },
  placing: { tone: 'neutral', text: 'Placing…' }, filled: { tone: 'ok', text: 'Placed' }, skipped: { tone: 'neutral', text: 'Skipped' },
  cancelled: { tone: 'neutral', text: 'Cancelled' }, expired: { tone: 'neutral', text: 'Expired' }, blocked: { tone: 'danger', text: 'Not placed' },
};

export const planLine = (p: TradePlan) =>
  `${p.side === 'buy' ? 'BUY' : 'SELL'} ${p.entry === 'limit' ? 'limit at' : 'when price reaches'} ${p.zone.low}-${p.zone.high} · stop ${p.slPips} pips${p.tpPips ? ` · target ${p.tpPips} pips (${(p.tpPips / p.slPips).toFixed(1)}R)` : ''} · risk ${p.riskPct}%`;

/** Popups from the assistant: "zone reached, take it?" and short result messages. Everything is in pips. */
export function AssistantOverlays({ api }: { api: AurumApi | undefined }) {
  const [ask, setAsk] = useState<{ plan: TradePlan; text: string } | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; priority: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => api?.onAssistAsk((e) => { setAsk(e); setErr(null); }), [api]);
  useEffect(() => api?.onAssistEvent((e) => {
    const t = { id: Date.now() + Math.random(), ...e };
    setToasts((cur) => [...cur, t].slice(-3));
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), 12_000);
  }), [api]);
  // If the plan was answered elsewhere (WhatsApp), close the question.
  useEffect(() => api?.onAssistChanged(() => { if (ask) void api.assistList().then((l) => { const p = l.find((x) => x.id === ask.plan.id); if (p && p.status !== 'asking') setAsk(null); }); }), [api, ask]);
  const answer = useCallback(async (take: boolean) => {
    if (!api || !ask) return;
    setBusy(true); setErr(null);
    try { await (take ? api.assistTake(ask.plan.id) : api.assistSkip(ask.plan.id)); setAsk(null); } catch (e) { setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)); } finally { setBusy(false); }
  }, [api, ask]);
  return (
    <>
      {ask && (
        <div className="dialog-back" role="presentation">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-label="Zone reached" style={{ maxWidth: 520 }}>
            <div className="dialog-h"><h3><Crosshair size={16} aria-hidden="true" /> Zone reached</h3></div>
            <div className="dialog-b">
              <p style={{ margin: 0 }}>{ask.text}</p>
              <span className="hint">{planLine(ask.plan)}</span>
              <span className="hint">If you take it, the lot size comes from your risk % and the stop in pips, and the risk rules run first. Nothing is placed if they refuse.</span>
              {err && <div className="banner banner-warn" role="alert">{err}</div>}
            </div>
            <div className="dialog-f">
              <Button onClick={() => void answer(false)} disabled={busy}>Skip</Button>
              <Button variant="primary" autoFocus onClick={() => void answer(true)} disabled={busy}>{busy ? 'Placing…' : 'Take the trade'}</Button>
            </div>
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="toasts" style={{ bottom: 80 }} role="region" aria-label="Assistant messages" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.priority === 'critical' ? 'toast-critical' : ''}`} role="status" data-testid="assist-toast">
              <Bot size={16} aria-hidden="true" />
              <div className="toast-b"><b>Assistant</b><span>{t.text}</span></div>
              <IconButton label="Dismiss" onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}><X size={14} /></IconButton>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Plans tab: your trade plans, in pips. */
export function PlansPanel({ api, enabled, onSettings }: { api?: AurumApi; enabled: boolean; onSettings: () => void }) {
  const [plans, setPlans] = useState<TradePlan[]>([]);
  const [form, setForm] = useState<{ side: 'buy' | 'sell'; low: string; high: string; sl: string; tp: string; risk: string; entry: 'touch' | 'limit'; auto: boolean; hours: string; note: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { void api?.assistList().then(setPlans).catch(() => undefined); }, [api]);
  useEffect(() => { load(); const off = api?.onAssistChanged(load); const t = setInterval(load, 4000); return () => { off?.(); clearInterval(t); }; }, [api, load]);
  const run = (f: () => Promise<unknown>) => { setMsg(null); void f().then(load).catch((e: unknown) => setMsg(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))); };
  if (!api) return <EmptyState icon={Bot} title="Open the Aurum desktop app to use trade plans." />;
  return (
    <div className="plans">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {enabled ? <Chip tone="ok">Assistant on</Chip> : <Chip tone="warn">Assistant off</Chip>}
        {!enabled && <Button size="sm" onClick={onSettings}>Turn it on in Settings &gt; Trading</Button>}
        <Button size="sm" icon={Crosshair} onClick={() => setForm({ side: 'buy', low: '', high: '', sl: '', tp: '', risk: '', entry: 'touch', auto: false, hours: '', note: '' })}>New plan</Button>
        <span className="hint">A plan waits for price to reach a zone. You approve each plan; stops and targets are in pips.</span>
      </div>
      {msg && <div className="banner banner-warn" role="alert"><span>{msg}</span></div>}
      {form && (
        <div className="planform">
          <Segmented<'buy' | 'sell'> label="Side" size="sm" value={form.side} onChange={(side) => setForm({ ...form, side })} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} />
          {([['low', 'Zone low (price)'], ['high', 'Zone high (price)'], ['sl', 'Stop (pips)'], ['tp', 'Target (pips)'], ['risk', 'Risk %'], ['hours', 'Valid for hours']] as const).map(([k, label]) => (
            <input key={k} className="input mono" style={{ width: 128 }} inputMode="decimal" aria-label={label} placeholder={label} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          ))}
          <Segmented<'touch' | 'limit'> label="Entry" size="sm" value={form.entry} onChange={(entry) => setForm({ ...form, entry })} options={[{ value: 'touch', label: 'Market at the zone' }, { value: 'limit', label: 'Pending limit' }]} />
          <input className="input" style={{ flex: 1, minWidth: 180 }} aria-label="Note" placeholder="Note (why this zone)" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <Button size="sm" variant="primary" onClick={() => {
            const n = (s: string) => (s.trim() === '' ? undefined : Number(s));
            const low = Number(form.low), high = Number(form.high);
            if (!(low > 0) || !(high > low)) { setMsg('Enter the zone prices: low below high.'); return; }
            run(async () => { await api.assistCreate({ side: form.side, zone: { low, high }, entry: form.entry, slPips: n(form.sl), tpPips: n(form.tp), riskPct: n(form.risk), expiryHours: n(form.hours), note: form.note }); setForm(null); });
          }}>Create (then approve it)</Button>
          <Button size="sm" onClick={() => setForm(null)}>Close</Button>
        </div>
      )}
      {plans.length === 0 ? (
        <EmptyState icon={CircleHelp} title="No plans yet">Create one here, or ask the AI to propose a plan for a zone.</EmptyState>
      ) : (
        <table className="dtable">
          <thead><tr><th>Plan</th><th>Status</th><th /></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td><div>{planLine(p)}</div><div className="hint">{p.statusDetail}{p.note ? ` · ${p.note}` : ''}{p.createdBy === 'ai' ? ' · proposed by the AI' : ''}</div></td>
                <td><Chip tone={STATUS[p.status].tone}>{STATUS[p.status].text}</Chip></td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    {p.status === 'proposed' && <>
                      <Button size="sm" variant="primary" onClick={() => run(() => api.assistApprove(p.id, false))}>Approve: ask me at the zone</Button>
                      <Button size="sm" onClick={() => run(() => api.assistApprove(p.id, true))}>Approve: place it automatically</Button>
                    </>}
                    {(p.status === 'armed' || p.status === 'asking') && <Button size="sm" onClick={() => run(() => api.assistTake(p.id))}>Take now</Button>}
                    {p.status === 'asking' && <Button size="sm" onClick={() => run(() => api.assistSkip(p.id))}>Skip</Button>}
                    {(p.status === 'proposed' || p.status === 'armed' || p.status === 'asking') && <Button size="sm" variant="danger" onClick={() => run(() => api.assistCancel(p.id))}>Cancel</Button>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span className="hint">Management of open trades (breakeven, trailing, partial) is set in pips under Settings &gt; Trading &gt; Assistant. {fmtPips(50)} means 5.00 on gold.</span>
    </div>
  );
}
