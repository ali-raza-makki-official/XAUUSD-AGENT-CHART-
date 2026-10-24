import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, CircleAlert, CircleCheck, CircleHelp, Clock, RefreshCw, ShieldCheck } from 'lucide-react';
import type { WaHistoryEntry } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, Chip, EmptyState, type Tone } from './ui';

const STATUS_TONE: Partial<Record<WaHistoryEntry['status'], Tone>> = {
  executed: 'ok', confirmed: 'ok', replied: 'ok', sent: 'ok', delivered: 'ok', read: 'ok', linked: 'ok',
  confirm_required: 'gold', pairing: 'gold', received: 'neutral', cancelled: 'neutral', duplicate: 'neutral', ignored: 'neutral', missed_summary: 'warn',
  expired: 'warn', unknown_outcome: 'warn', dropped: 'warn', rejected_permission: 'danger', rejected_identity: 'danger', rejected_code: 'danger', failed: 'danger',
};
const iconFor = (s: WaHistoryEntry['status']) =>
  ['executed', 'confirmed', 'replied', 'sent', 'delivered', 'read', 'linked'].includes(s) ? CircleCheck
    : ['confirm_required', 'pairing'].includes(s) ? ShieldCheck
    : ['expired', 'unknown_outcome', 'dropped', 'missed_summary'].includes(s) ? Clock
    : ['failed', 'rejected_permission', 'rejected_identity', 'rejected_code'].includes(s) ? CircleAlert : CircleHelp;

/** Command history: everything that came in over WhatsApp and what Aurum did with it. Confirmation codes are masked before they are stored. */
export function WhatsAppHistory({ api }: { api: AurumApi }) {
  const [rows, setRows] = useState<WaHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api.waHistory(150).then((r) => { setRows(r); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, [api]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  return (
    <div className="field" data-testid="wa-history">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="lbl">Command history (newest first)</span>
        <Button size="sm" icon={RefreshCw} onClick={load}>Refresh</Button>
      </div>
      {err && <Chip tone="danger" icon={CircleAlert}>{err}</Chip>}
      {rows && rows.length === 0 && <EmptyState icon={Clock} title="No WhatsApp activity yet">Messages you send to the agent and Aurum's replies will be listed here.</EmptyState>}
      {rows && rows.length > 0 && (
        <div className="scroll" style={{ maxHeight: 320 }}>
          <table className="dtable">
            <thead><tr><th>Time</th><th>Dir</th><th>What</th><th>Result</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const Icon = iconFor(r.status);
                return (
                  <tr key={r.id}>
                    <td className="mono">{new Date(r.at).toLocaleTimeString()}</td>
                    <td>{r.direction === 'in' ? <span title="From you"><ArrowDownLeft size={13} aria-label="incoming" /></span> : r.direction === 'out' ? <span title="From Aurum"><ArrowUpRight size={13} aria-label="outgoing" /></span> : 'sys'}</td>
                    <td title={r.detail ?? undefined} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.summary}</td>
                    <td><Chip tone={STATUS_TONE[r.status] ?? 'neutral'} icon={Icon} title={r.detail ?? undefined}>{r.status.replace(/_/g, ' ')}</Chip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
