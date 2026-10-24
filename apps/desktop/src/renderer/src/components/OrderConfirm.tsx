import { useCallback, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, LoaderCircle, ShieldAlert, TriangleAlert } from 'lucide-react';
import { stampCommand, type AnyOrderCommand, type OrderRecord, type PrepareResult } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, Chip } from './ui';

type Prepared = Extract<PrepareResult, { ok: true; executable: boolean }>;
type Phase =
  | { k: 'closed' }
  | { k: 'preparing' }
  | { k: 'review'; p: Prepared; extra: string[] }
  | { k: 'sending'; p: Prepared }
  | { k: 'done'; p: Prepared; r: OrderRecord }
  | { k: 'error'; message: string };

/** Every order action goes prepare -> review -> explicit Confirm -> result. Nothing is sent without the Confirm click. */
export function useOrderFlow(api: AurumApi | undefined, symbol: string) {
  const [phase, setPhase] = useState<Phase>({ k: 'closed' });

  const open = useCallback(async (body: { type: string } & Record<string, unknown>, extra: string[] = []) => {
    if (!api) return;
    setPhase({ k: 'preparing' });
    try {
      const res = await api.ordersPrepare(stampCommand(body, { actor: 'manual', symbol }) as unknown as AnyOrderCommand);
      if (!res.ok) setPhase({ k: 'error', message: res.error });
      else if (!('preview' in res)) setPhase({ k: 'error', message: 'This command was already handled.' });
      else setPhase({ k: 'review', p: res as Prepared, extra });
    } catch (e) { setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) }); }
  }, [api, symbol]);

  const dialog: ReactNode = phase.k === 'closed' ? null : (
    <OrderDialog
      phase={phase} onClose={() => setPhase({ k: 'closed' })}
      onConfirm={async () => {
        if (phase.k !== 'review' || !api) return;
        const p = phase.p;
        setPhase({ k: 'sending', p });
        try { setPhase({ k: 'done', p, r: await api.ordersConfirm(p.commandId) }); } catch (e) { setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) }); }
      }}
      onReconcile={async () => {
        if (phase.k !== 'done' || !api) return;
        const p = phase.p;
        try { setPhase({ k: 'done', p, r: await api.ordersReconcile(p.commandId) }); } catch (e) { setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) }); }
      }}
    />
  );
  const fail = useCallback((message: string) => setPhase({ k: 'error', message }), []);
  return { open, fail, dialog };
}

function OrderDialog({ phase, onClose, onConfirm, onReconcile }: { phase: Phase; onClose: () => void; onConfirm: () => void; onReconcile: () => void }) {
  const p = 'p' in phase ? phase.p : null;
  const busy = phase.k === 'preparing' || phase.k === 'sending';
  return (
    <div className="dialog-back" role="presentation">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label="Confirm order action" style={{ width: 520 }}>
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
              <span className="hint">Nothing is sent until you press the button below. This request expires in about 2 minutes.</span>
            </>
          )}
          {phase.k === 'done' && <Result r={phase.r} />}
        </div>
        <div className="dialog-f">
          {phase.k === 'review' && (
            <>
              <Button onClick={onClose} autoFocus>Cancel</Button>
              <Button variant={phase.p.preview.destructive ? 'danger' : 'primary'} disabled={!phase.p.executable} onClick={onConfirm}>
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
