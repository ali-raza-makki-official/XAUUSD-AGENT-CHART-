import { useCallback, useEffect, useState } from 'react';
import { Brain, Check, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import type { AppConfig, MemoryNote, PaperTrade } from '@aurum/core';
import type { AurumApi, LearnInsights } from '../../../shared';
import { Button, EmptyState, IconButton } from './ui';

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const mb = (b: number) => (b < 1e6 ? `${Math.round(b / 1e3)} KB` : `${(b / 1e6).toFixed(1)} MB`);
const SRC: Record<PaperTrade['source'], string> = { plan: 'Trade plan', analysis: 'AI idea', user: 'My idea' };
const STATUS: Record<PaperTrade['status'], string> = { pending: 'Waiting', open: 'Open', won: 'Would have won', lost: 'Would have lost', timeout: 'Timed out', expired: 'Never reached' };
const tone = (n?: number) => (n === undefined || n === 0 ? undefined : { color: n > 0 ? 'var(--buy)' : 'var(--sell)' });

/** What the app measured: paper trades on real ticks, findings, a data-backed default suggestion, and what it remembers about you. */
export function LearningPanel({ api, config }: { api?: AurumApi; config?: AppConfig | null }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [ins, setIns] = useState<LearnInsights | null>(null);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [mem, setMem] = useState<{ turns: number; notes: number; first: number | null } | null>(null);
  const [note, setNote] = useState('');
  const [idea, setIdea] = useState({ side: 'buy' as 'buy' | 'sell', low: '', high: '', sl: '', tp: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async (force = false) => {
    if (!api) return;
    const [t, i, n, m] = await Promise.all([api.paperList().catch(() => []), api.learnInsights(force).catch(() => null), api.memoryNotes().catch(() => []), api.memoryStats().catch(() => null)]);
    setTrades(t); setIns(i); setNotes(n); setMem(m);
  }, [api]);
  useEffect(() => { void load(); const off = api?.onPaperChanged(() => void load()); const t = setInterval(() => void load(), 15_000); return () => { off?.(); clearInterval(t); }; }, [api, load]);

  if (!api) return <EmptyState icon={Brain} title="Open the Aurum desktop app to see learning results." />;
  const done = trades.filter((t) => t.status === 'won' || t.status === 'lost' || t.status === 'timeout');
  const tuning = ins?.tuning ?? null;

  const addIdea = async () => {
    const low = Number(idea.low), high = Number(idea.high), sl = Number(idea.sl), tp = idea.tp.trim() === '' ? null : Number(idea.tp);
    if (!(low > 0) || !(high > low) || !(sl > 0) || (tp !== null && !(tp > 0))) { setMsg('Zone low must be below zone high; stop and target are pips above zero.'); return; }
    await api.paperRecord({ source: 'user', side: idea.side, zone: { low, high }, slPips: sl, tpPips: tp });
    setMsg('Recorded. It is judged on real ticks as soon as price reaches the zone.'); setIdea({ ...idea, low: '', high: '' }); void load();
  };

  return (
    <div className="journal" aria-label="Learning">
      <div className="hint" style={{ marginBottom: 8 }}>
        Every trade plan, AI trade idea and idea of yours is judged on the real recorded ticks, whether or not you traded it live. Aurum does not retrain any AI model and does not rewrite itself: it measures, remembers and suggests.
      </div>
      <div className="row" style={{ gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <span className="hint">{config?.learning.recordTicks ? 'Recording ticks' : 'Tick recording is OFF'}{ins ? `: ${ins.ticks.count.toLocaleString()} ticks (${mb(ins.ticks.approxBytes)})${ins.ticks.first ? `, since ${when(ins.ticks.first)}` : ''}` : ''}</span>
        <span className="hint">{ins ? `${ins.finished} finished, ${ins.open} open paper trades` : ''}</span>
        <span className="hint">{mem ? `${mem.turns.toLocaleString()} chat turns and ${mem.notes} notes remembered${mem.first ? ` since ${when(mem.first)}` : ''}` : ''}{config && !config.learning.memory ? ' (memory is OFF)' : ''}</span>
        <Button size="sm" icon={RefreshCw} onClick={() => void load(true)}>Refresh</Button>
      </div>

      {ins && ins.findings.length > 0 && (
        <section aria-label="Findings"><h4>What the data says</h4>
          {ins.findings.map((f, i) => <div key={i} className="hint" style={{ color: f.kind === 'good' ? 'var(--buy)' : f.kind === 'bad' ? 'var(--sell)' : undefined }}>{f.text}</div>)}
        </section>
      )}

      <section aria-label="Default stop and target"><h4>Default stop and target</h4>
        {!tuning ? <span className="hint">Not enough replayable paper trades yet. Suggestions start once trades have recorded ticks around them.</span> : (
          <div className="vcmp" role="status">
            <span><b>Now:</b> {tuning.current.slPips} pip stop / {tuning.current.tpPips} pip target. <b>Best found:</b> {tuning.best.slPips} / {tuning.best.tpPips ?? 'none'}.</span>
            <span className="hint">{tuning.reason}</span>
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="primary" icon={Check} disabled={tuning.best.slPips === tuning.current.slPips && tuning.best.tpPips === tuning.current.tpPips} onClick={() => void api.learnApply(tuning.best.slPips, tuning.best.tpPips ?? tuning.current.tpPips).then(() => { setMsg('Applied to new plans. Undo is below.'); void load(true); })}>Use {tuning.best.slPips} / {tuning.best.tpPips ?? tuning.current.tpPips} for new plans</Button>
              {!tuning.confident && <span className="hint">Early evidence only; the app will not apply this by itself.</span>}
            </div>
          </div>
        )}
        {ins && ins.log.length > 0 && (
          <div>{ins.log.slice(0, 5).map((l) => <div key={l.at} className="hint">{when(l.at)} · {l.auto ? 'automatic' : 'by you'}: {l.from.slPips}/{l.from.tpPips} → {l.to.slPips}/{l.to.tpPips}. {l.evidence}</div>)}
            <Button size="sm" icon={Undo2} onClick={() => void api.learnRevert().then((r) => { setMsg(r.ok ? 'Restored the previous defaults.' : 'Nothing to undo.'); void load(true); })}>Undo last change</Button></div>
        )}
      </section>

      <section aria-label="Paper trades"><h4>Paper trades</h4>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }} role="group" aria-label="Add my idea">
          <select className="input" aria-label="Idea side" value={idea.side} onChange={(e) => setIdea({ ...idea, side: e.target.value as 'buy' | 'sell' })}><option value="buy">Buy</option><option value="sell">Sell</option></select>
          <input className="input mono" style={{ width: 90 }} inputMode="decimal" placeholder="Zone low" aria-label="Idea zone low" value={idea.low} onChange={(e) => setIdea({ ...idea, low: e.target.value })} />
          <input className="input mono" style={{ width: 90 }} inputMode="decimal" placeholder="Zone high" aria-label="Idea zone high" value={idea.high} onChange={(e) => setIdea({ ...idea, high: e.target.value })} />
          <input className="input mono" style={{ width: 80 }} inputMode="decimal" placeholder="Stop pips" aria-label="Idea stop pips" value={idea.sl} onChange={(e) => setIdea({ ...idea, sl: e.target.value })} />
          <input className="input mono" style={{ width: 90 }} inputMode="decimal" placeholder="Target pips" aria-label="Idea target pips" value={idea.tp} onChange={(e) => setIdea({ ...idea, tp: e.target.value })} />
          <Button size="sm" onClick={() => void addIdea()}>Paper-test my idea</Button>
        </div>
        {trades.length === 0 ? <EmptyState icon={Brain} title="No paper trades yet. Trade plans, AI trade ideas and your ideas appear here.">They are judged automatically on live ticks while the MT5 feed is connected.</EmptyState> : (
          <table className="table" aria-label="Paper trades list">
            <thead><tr><th>Created</th><th>From</th><th>Side</th><th>Zone</th><th>Stop/Target</th><th>Result</th><th>Pips</th><th>Live?</th></tr></thead>
            <tbody>{trades.slice(0, 60).map((t) => (
              <tr key={t.id}>
                <td>{when(t.createdAt)}</td><td>{SRC[t.source]}</td><td style={{ textTransform: 'capitalize' }}>{t.side}</td>
                <td className="mono">{t.zone ? `${t.zone.low}–${t.zone.high}` : '—'}</td><td className="mono">{t.slPips} / {t.tpPips ?? '—'}</td>
                <td title={t.endReason}>{STATUS[t.status]}</td><td className="mono" style={tone(t.resultPips)}>{t.resultPips === undefined ? '—' : `${t.resultPips > 0 ? '+' : ''}${t.resultPips.toFixed(1)}`}</td>
                <td>{t.live ? 'Traded' : done.includes(t) ? 'Paper only' : '—'}</td>
              </tr>))}</tbody>
          </table>
        )}
      </section>

      <section aria-label="Memory"><h4>What Aurum remembers about you</h4>
        {notes.length === 0 && <span className="hint">No notes yet. Tell the AI a rule or lesson, or add one here. The AI can also save notes itself (they appear here and you can delete any).</span>}
        {notes.map((n) => <div key={n.id} className="row" style={{ gap: 6 }}><span className="hint" style={{ flex: 1 }}>({n.kind}{n.source === 'ai' ? ', saved by AI' : ''}) {n.text}</span><IconButton label="Forget this note" onClick={() => void api.memoryForget(n.id).then(() => load())}><Trash2 size={14} /></IconButton></div>)}
        <div className="row" style={{ gap: 6 }}>
          <input className="input" style={{ flex: 1 }} maxLength={400} placeholder="Add a note, e.g. I never trade Friday evening" aria-label="New memory note" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={note.trim().length < 3} onClick={() => void api.memoryRemember({ kind: 'preference', text: note.trim(), weight: 4, source: 'user' }).then(() => { setNote(''); void load(); })}>Remember</Button>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          {!confirmClear ? <Button size="sm" icon={Trash2} onClick={() => setConfirmClear(true)}>Forget everything (notes and chat archive)</Button> : (
            <><span className="hint">This deletes all notes and the saved chat archive. Paper trades and ticks stay.</span>
              <Button size="sm" variant="danger" onClick={() => void api.memoryClear().then(() => { setConfirmClear(false); setMsg('Memory cleared.'); void load(); })}>Yes, forget</Button><Button size="sm" onClick={() => setConfirmClear(false)}>Cancel</Button></>
          )}
        </div>
      </section>
      {msg && <span className="hint" role="status">{msg}</span>}
    </div>
  );
}
