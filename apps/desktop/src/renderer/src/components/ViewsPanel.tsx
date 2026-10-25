import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleHelp, Plus, Save, Scale, X, MessageSquare } from 'lucide-react';
import { UserViewSchema, compareViews, type AiView, type Bias, type Timeframe, type UserView, type ViewLevel } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, EmptyState, IconButton, Segmented } from './ui';
import { TimeframeMenu } from './TimeframeMenu';

const BIAS: { value: Bias; label: string }[] = [{ value: 'bullish', label: 'Bullish' }, { value: 'bearish', label: 'Bearish' }, { value: 'ranging', label: 'Ranging' }, { value: 'unclear', label: 'Unclear' }];
const KINDS: ViewLevel['kind'][] = ['support', 'resistance', 'supply', 'demand', 'pivot', 'other'];
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Your own read of the market next to the AI's latest analysis, with a plain comparison. Both sides are real text the two of you wrote. */
export function ViewsPanel({ api, tf, onAskAi }: { api?: AurumApi; tf: Timeframe; onAskAi: (text: string) => void }) {
  const [mine, setMine] = useState<UserView | null>(null);
  const [ai, setAi] = useState<AiView | null>(null);
  const [draft, setDraft] = useState<{ bias: Bias; timeframe: Timeframe; levels: { price: string; kind: ViewLevel['kind'] }[]; invalidation: string; note: string }>({ bias: 'unclear', timeframe: tf, levels: [], invalidation: '', note: '' });
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    const [u, a] = await Promise.all([api.kvGet('user_view').catch(() => null), api.kvGet('ai_view').catch(() => null)]);
    try { const p = u ? UserViewSchema.safeParse(JSON.parse(u)) : null; if (p?.success) { setMine(p.data); setDraft({ bias: p.data.bias, timeframe: p.data.timeframe, levels: p.data.levels.map((l) => ({ price: String(l.price), kind: l.kind })), invalidation: p.data.invalidation, note: p.data.note }); } } catch { /* a damaged saved view is simply ignored */ }
    try { setAi(a ? (JSON.parse(a) as AiView) : null); } catch { setAi(null); }
  }, [api]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);

  const save = async () => {
    if (!api) return;
    const levels = draft.levels.filter((l) => l.price.trim() !== '').map((l) => ({ price: Number(l.price), kind: l.kind }));
    const parsed = UserViewSchema.safeParse({ bias: draft.bias, timeframe: draft.timeframe, levels, invalidation: draft.invalidation, note: draft.note, savedAt: Date.now() });
    if (!parsed.success) { setMsg('Check the level prices: each must be a number above zero.'); return; }
    await api.kvSet('user_view', JSON.stringify(parsed.data));
    setMine(parsed.data); setMsg('Saved. The AI can read your view when you ask what it thinks.');
  };

  const cmp = useMemo(() => compareViews(mine, ai, 3), [mine, ai]);
  if (!api) return <EmptyState icon={Scale} title="Open the Aurum desktop app to use views." />;
  return (
    <div className="views">
      <section className="vcol" aria-label="My view">
        <h4>My view</h4>
        <Segmented<Bias> label="My bias" size="sm" value={draft.bias} onChange={(bias) => setDraft({ ...draft, bias })} options={BIAS} />
        <div className="row" style={{ gap: 8 }}><span className="hint">Timeframe</span><TimeframeMenu value={draft.timeframe} onChange={(timeframe) => setDraft({ ...draft, timeframe })} label="View timeframe" /></div>
        <div className="vlevels">
          {draft.levels.map((l, i) => (
            <div className="row" key={i} style={{ gap: 6 }}>
              <input className="input mono" style={{ width: 110 }} inputMode="decimal" placeholder="Price" aria-label={`Level ${i + 1} price`} value={l.price} onChange={(e) => setDraft({ ...draft, levels: draft.levels.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
              <select className="input" aria-label={`Level ${i + 1} type`} value={l.kind} onChange={(e) => setDraft({ ...draft, levels: draft.levels.map((x, j) => (j === i ? { ...x, kind: e.target.value as ViewLevel['kind'] } : x)) })}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
              <IconButton label="Remove level" onClick={() => setDraft({ ...draft, levels: draft.levels.filter((_, j) => j !== i) })}><X size={14} /></IconButton>
            </div>
          ))}
          {draft.levels.length < 12 && <Button size="sm" icon={Plus} onClick={() => setDraft({ ...draft, levels: [...draft.levels, { price: '', kind: 'support' }] })}>Add level</Button>}
        </div>
        <input className="input" placeholder="What invalidates my view?" aria-label="Invalidation" maxLength={400} value={draft.invalidation} onChange={(e) => setDraft({ ...draft, invalidation: e.target.value })} />
        <textarea className="input" rows={2} placeholder="Notes (why I think so)" aria-label="Notes" maxLength={1000} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" size="sm" icon={Save} onClick={() => void save()}>Save my view</Button>
          <Button size="sm" icon={MessageSquare} disabled={!mine} onClick={() => onAskAi('Here is my view of the market (you can read it with get_my_view). Do you agree? Tell me plainly where you agree and where you do not, and why.')}>Ask the AI about my view</Button>
          {mine && <span className="hint">Saved {when(mine.savedAt)}</span>}
        </div>
        {msg && <span className="hint" role="status">{msg}</span>}
      </section>
      <section className="vcol" aria-label="AI view">
        <h4>AI view</h4>
        {!ai ? <EmptyState icon={CircleHelp} title="No AI analysis yet. Ask the AI to analyse the chart and it will appear here." /> : (
          <>
            <div className="row" style={{ gap: 8 }}><b style={{ textTransform: 'capitalize' }}>{ai.bias}</b>{ai.noSetup && <span className="hint">no clean setup</span>}<span className="hint">{ai.timeframes.join(', ')} · {when(ai.savedAt)}</span></div>
            <div className="vlevels">{ai.levels.map((l, i) => <div key={i} className="mono vl"><span>{l.price.toFixed(2)}</span><span className="hint">{l.kind}</span></div>)}</div>
            {ai.invalidation && <div className="hint">Invalid if: {ai.invalidation}</div>}
          </>
        )}
        <div className={`vcmp vcmp-${cmp.bias}`} role="status"><b>Comparison</b><span>{cmp.summary}</span>
          {cmp.shared.length > 0 && <span className="hint">Matching: {cmp.shared.map((s) => `${s.user.price} ≈ ${s.ai.price}`).join(', ')}</span>}
          {cmp.userOnly.length > 0 && <span className="hint">Only you: {cmp.userOnly.map((l) => l.price).join(', ')}</span>}
          {cmp.aiOnly.length > 0 && <span className="hint">Only the AI: {cmp.aiOnly.map((l) => l.price).join(', ')}</span>}
        </div>
      </section>
    </div>
  );
}
