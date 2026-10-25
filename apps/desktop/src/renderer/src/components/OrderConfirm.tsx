import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, CircleX, LoaderCircle, ShieldAlert, TriangleAlert } from 'lucide-react';
import { stampCommand, type AnyOrderCommand, type AppConfig, type ChecklistResult, type OrderRecord, type PrepareResult } from '@aurum/core';
import { gatherChecklist } from '../lib/pretrade';
import type { AurumApi } from '../../../shared';
import { Button, Chip } from './ui';

type Prepared = Extract<PrepareResult, { ok: true; executable: boolean }>;
type Phase =
  | { k: 'closed' }
  | { k: 'preparing' }
  | { k: 'review'; p: Prepared; extra: string[]; list: ChecklistResult | null | 'loading' }
  | { k: 'sending'; p: Prepared }
  | { k: 'done'; p: Prepared; r: OrderRecord }
  | { k: 'error'; message: string };

/** Every order action goes prepare -> review -> explicit Confirm -> result. Nothing is sent without the Confirm click. */
export function useOrderFlow(api: AurumApi | undefined, symbol: string, config?: AppConfig | null, tick?: { bid: number; ask: number } | null) {
  const tickRef = useRef(tick ?? null);
  tickRef.current = tick ?? null;
  const [phase, setPhase] = useState<Phase>({ k: 'closed' });
  const [ack, setAck] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const review = useCallback((p: Prepared, extra: string[]) => {
    setAck(false); setTicked([]);
    setPhase({ k: 'review', p, extra, list: config && api ? 'loading' : null });
    if (!config || !api) return;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));
    void Promise.race([gatherChecklist(api, config, p, tickRef.current).catch((e) => { console.error('checklist failed:', e); return null; }), timeout]).then((list) => {
      setPhase((cur) => (cur.k === 'review' && cur.p.commandId === p.commandId ? { ...cur, list } : cur));
    });
  }, [api, config]);

  const open = useCallback(async (body: { type: string } & Record<string, unknown>, extra: string[] = []) => {
    if (!api) return;
    setPhase({ k: 'preparing' });
    try {
      const res = await api.ordersPrepare(stampCommand(body, { actor: 'manual', symbol }) as unknown as AnyOrderCommand);
      if (!res.ok) setPhase({ k: 'error', message: res.error });
      else if (!('preview' in res)) setPhase({ k: 'error', message: 'This command was already handled.' });
      else review(res as Prepared, extra);
    } catch (e) { setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) }); }
  }, [api, symbol, review]);

  const dialog: ReactNode = phase.k === 'closed' ? null : (
    <OrderDialog
      phase={phase} ack={ack} onAck={setAck} ticked={ticked} onTick={(id, on) => setTicked((t) => (on ? [...t, id] : t.filter((x) => x !== id)))} onClose={() => setPhase({ k: 'closed' })}
      onConfirm={async () => {
        if (phase.k !== 'review' || !api) return;
        const p = phase.p;
        setPhase({ k: 'sending', p });
        if (phase.list && phase.list !== 'loading') {
          const snapshot = { items: phase.list.items.map((i) => ({ id: i.id, label: i.label, status: i.status })), acknowledged: ack, ticked };
          await api.journalSaveCheck(p.commandId, snapshot).catch(() => undefined); // the journal note must never block an order
        }
        try { setPhase({ k: 'done', p, r: await api.ordersConfirm(p.commandId) }); } catch (e) { setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) }); }
      }}
      onReconcile={async () => {
        if (phase.k !== 'done' || !api) return;
        const p = phase.p;
        try { setPhase({ k: 'done', p, r: await api.ordersReconcile(p.commandId) }); } catch (e) { setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) }); }
      }}
    />
  );
  const showPrepared = useCallback((p: PrepareResult) => { if (p.ok && 'preview' in p) review(p as Prepared, ['Proposed by the AI. Check every line yourself; the risk rules run again when you confirm.']); }, [review]);
  const fail = useCallback((message: string) => setPhase({ k: 'error', message }), []);
  return { open, fail, showPrepared, dialog };
}

function OrderDialog({ phase, ack, onAck, ticked, onTick, onClose, onConfirm, onReconcile }: { phase: Phase; ack: boolean; onAck: (v: boolean) => void; ticked: string[]; onTick: (id: string, on: boolean) => void; onClose: () => void; onConfirm: () => void; onReconcile: () => void }) {
  const p = 'p' in phase ? phase.p : null;
  const list = phase.k === 'review' && phase.list && phase.list !== 'loading' ? phase.list : null;
  const loadingList = phase.k === 'review' && phase.list === 'loading';
  const missingRequired = list ? list.manual.filter((m) => m.required && !ticked.includes(m.id)).length : 0;
  const needAck = !!list?.needsAck && !ack;
  const ready = !loadingList && missingRequired === 0 && !needAck;
  const busy = phase.k === 'preparing' || phase.k === 'sending';
  return (
    <div className="dialog-back page" role="presentation">
      <div className="dialog page review" role="alertdialog" aria-modal="true" aria-label="Confirm order action">
        <div className="dialog-h">
          <h3>{p ? p.preview.title : phase.k === 'error' ? 'Order action failed' : 'Preparing…'}</h3>
          {p?.account && (p.account.demo ? <Chip tone="ai" icon={ShieldAlert}>DEMO account</Chip> : <Chip tone="gold">LIVE account</Chip>)}
        </div>
        <div className="dialog-b">
          {busy && <div className="row"><LoaderCircle size={16} className="spin" /> {phase.k === 'sending' ? 'Sending to MT5 and waiting for the broker…' : 'Checking risk limits…'}</div>}
          {phase.k === 'error' && <div className="banner banner-warn" role="alert">{phase.message}</div>}
          {phase.k === 'review' && (
            <>
              <ul className="ac-list">{phase.p.preview.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              {phase.extra.length > 0 && <div className="calc">{phase.extra.map((l, i) => <div key={i}>{l}</div>)}</div>}
              {phase.p.gate.warnings.map((w, i) => <div key={i} className="warn"><TriangleAlert size={12} /> {w}</div>)}
              {!phase.p.gate.ok && (
                <div className="banner banner-danger" role="alert">
                  <div><b>Blocked by the risk rules:</b>{phase.p.gate.failures.map((f, i) => <div key={i}>{f.message}</div>)}</div>
                </div>
              )}
              {loadingList && <div className="row hint"><LoaderCircle size={14} className="spin" /> Loading the pre-trade checklist…</div>}
              {list && <Checklist list={list} ack={ack} onAck={onAck} ticked={ticked} onTick={onTick} />}
              <span className="hint">Nothing is sent until you press the button below. This request expires in about 2 minutes.</span>
            </>
          )}
          {phase.k === 'done' && <Result r={phase.r} />}
        </div>
        <div className="dialog-f">
          {phase.k === 'review' && (
            <>
              <Button onClick={onClose} autoFocus>Cancel</Button>
              {!ready && !loadingList && <span className="hint">Finish the checklist to confirm.</span>}
              <Button variant={phase.p.preview.destructive ? 'danger' : 'primary'} disabled={!phase.p.executable || !ready} onClick={onConfirm}>
                {phase.p.preview.destructive ? 'Confirm and send to MT5' : 'Confirm and send to MT5'}
              </Button>
            </>
          )}
          {phase.k === 'done' && phase.r.state === 'unknown_reconcile' && <Button onClick={onReconcile}>Check MT5 now</Button>}
          {!busy && phase.k !== 'review' && <Button variant="primary" onClick={onClose} autoFocus>Close</Button>}
        </div>
      </div>
    </div>
  );
}

function Result({ r }: { r: OrderRecord }) {
  const ok = r.state === 'confirmed';
  const unknown = r.state === 'unknown_reconcile';
  return (
    <div className={`banner ${ok ? 'banner-ok' : unknown ? 'banner-warn' : 'banner-danger'}`} role="status">
      {ok ? <CircleCheck size={16} /> : unknown ? <TriangleAlert size={16} /> : <CircleX size={16} />}
      <div>
        <b>{ok ? 'Confirmed by MT5' : unknown ? 'Result unknown: do not retry' : r.state === 'rejected' ? 'Rejected' : 'Not sent'}</b>
        <div>{r.reason ?? r.broker?.message ?? r.history.at(-1)?.note}</div>
        {r.broker?.retcodeName && <div className="mono hint">{r.broker.retcodeName}{r.broker.positionTicket ? ` · ticket ${r.broker.positionTicket}` : ''}</div>}
        {unknown && <div>The order may or may not have reached the broker. Aurum will not send it again. Press "Check MT5 now", or look at MT5 yourself.</div>}
      </div>
    </div>
  );
}


const STATUS_ICON = { pass: CircleCheck, fail: CircleX, warn: TriangleAlert, unknown: CircleHelp } as const;
const STATUS_WORD = { pass: 'OK', fail: 'Fails', warn: 'Careful', unknown: 'Unknown' } as const;

/** Pre-trade checklist: automatic checks from real data, then your own questions. Unknown is shown, never counted as pass. */
function Checklist({ list, ack, onAck, ticked, onTick }: { list: ChecklistResult; ack: boolean; onAck: (v: boolean) => void; ticked: string[]; onTick: (id: string, on: boolean) => void }) {
  return (
    <section className="pretrade" aria-label="Pre-trade checklist">
      <h4>Pre-trade checklist</h4>
      <ul className="ptlist">
        {list.items.map((it) => {
          const Icon = STATUS_ICON[it.status];
          return (
            <li key={it.id} className={`pt pt-${it.status}`}>
              <Icon size={15} aria-hidden="true" />
              <div><b>{it.label}</b><span className="hint">{it.detail}</span></div>
              <span className="ptword">{STATUS_WORD[it.status]}</span>
            </li>
          );
        })}
      </ul>
      {list.manual.length > 0 && (
        <div className="ptmanual">
          {list.manual.map((m) => (
            <label key={m.id} className="ptcheck"><input type="checkbox" checked={ticked.includes(m.id)} onChange={(e) => onTick(m.id, e.target.checked)} /><span>{m.label}{m.required && <em> (required)</em>}</span></label>
          ))}
        </div>
      )}
      {list.needsAck && (
        <label className="ptcheck ptack"><input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} /><span>I have read the items marked Fails or Careful and still want to go ahead.</span></label>
      )}
    </section>
  );
}
