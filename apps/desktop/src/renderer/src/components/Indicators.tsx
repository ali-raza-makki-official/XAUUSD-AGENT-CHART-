import { useEffect } from 'react';
import { Activity, Eye, EyeOff, Lock, LockOpen, Plus, Sparkles, Trash2, User, X } from 'lucide-react';
import {
  INDICATORS, INDICATOR_TYPES, TIMEFRAMES, indicatorTitle, outputStyle, isIndicatorShownOn,
  type Indicator, type IndicatorType, type ParamDef, type Timeframe,
} from '@aurum/core';
import { ColorField, CommitNumber, CommitText, Field } from './Fields';
import { Button, Chip, EmptyState, IconButton, Section, Segmented, Switch } from './ui';

type Patch = Record<string, unknown>;

/** Dialog to pick an indicator to add. Adding goes through the same IndicatorStore command the AI tool uses. */
export function IndicatorsDialog({ onAdd, onClose }: { onAdd: (t: IndicatorType) => void; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="dialog-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Add indicator">
        <div className="dialog-h"><h3>Add indicator</h3><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton></div>
        <div className="dialog-b">
          <ul className="olist indlist">
            {INDICATOR_TYPES.map((t) => {
              const d = INDICATORS[t];
              return (
                <li key={t} className="indrow">
                  <div className="indinfo">
                    <div className="indname">{d.name}<Chip>{d.placement === 'overlay' ? 'On price' : 'Own pane'}</Chip></div>
                    <div className="hint">{d.description}</div>
                  </div>
                  <Button size="sm" icon={Plus} onClick={() => onAdd(t)} aria-label={`Add ${d.name}`}>Add</Button>
                </li>
              );
            })}
          </ul>
          <span className="hint">Values are calculated from the real MT5 candles. Each indicator can be restyled and limited to certain timeframes after you add it.</span>
        </div>
      </div>
    </div>
  );
}

interface PanelProps {
  indicators: Indicator[];
  selectedId: string | null;
  /** Timeframe of the active chart pane, to show which indicators are visible there. */
  activeTf: Timeframe;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Patch, label: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}

const LINES = [{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }] as const;

/** List of indicator instances plus the inspector for the selected one. */
export function IndicatorsPanel({ indicators, selectedId, activeTf, onSelect, onPatch, onDelete, onAdd }: PanelProps) {
  const selected = indicators.find((i) => i.id === selectedId) ?? null;
  return (
    <div className="panel-pad">
      <Button size="sm" icon={Plus} onClick={onAdd}>Add indicator</Button>
      {indicators.length === 0 ? (
        <EmptyState icon={Activity} title="No indicators">Add moving averages, RSI, MACD, Bollinger Bands and more. You or the AI can add them, and every change can be undone.</EmptyState>
      ) : (
        <ul className="olist">
          {indicators.map((i) => {
            const shown = isIndicatorShownOn(i, activeTf);
            return (
              <li key={i.id} className={`oitem ${i.origin.by} ${i.id === selectedId ? 'sel' : ''}`}>
                <button className="orow" onClick={() => onSelect(i.id === selectedId ? null : i.id)} aria-pressed={i.id === selectedId}>
                  <span className="ic" aria-hidden="true">{i.origin.by === 'ai' ? <Sparkles size={14} /> : <User size={14} />}</span>
                  <span className="oname" style={{ opacity: i.visible ? 1 : 0.55 }}>{indicatorTitle(i)}</span>
                  <span className="ometa">{!i.visible ? 'hidden' : shown ? (INDICATORS[i.type].placement === 'pane' ? 'pane' : 'on price') : `not on ${activeTf}`}</span>
                </button>
                <IconButton label={i.visible ? 'Hide indicator' : 'Show indicator'} pos="left" onClick={() => onPatch(i.id, { visible: !i.visible }, i.visible ? 'Hide indicator' : 'Show indicator')}>{i.visible ? <Eye size={15} /> : <EyeOff size={15} />}</IconButton>
                <IconButton label={i.locked ? 'Unlock indicator' : 'Lock indicator'} pos="left" pressed={i.locked} onClick={() => onPatch(i.id, { locked: !i.locked }, i.locked ? 'Unlock indicator' : 'Lock indicator')}>{i.locked ? <Lock size={15} /> : <LockOpen size={15} />}</IconButton>
                <IconButton label="Remove indicator" pos="left" tone="danger" disabled={i.locked} onClick={() => onDelete(i.id)}><Trash2 size={15} /></IconButton>
              </li>
            );
          })}
        </ul>
      )}
      {selected && <IndicatorInspector ind={selected} onPatch={(p, l) => onPatch(selected.id, p, l)} onDelete={() => onDelete(selected.id)} />}
    </div>
  );
}

function ParamField({ def, value, onCommit }: { def: ParamDef; value: number | string; onCommit: (v: number | string) => void }) {
  if (def.type === 'select') {
    return (
      <select className="select" aria-label={def.label} value={String(value)} onChange={(e) => onCommit(e.target.value)}>
        {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <CommitNumber label={def.label} value={Number(value)} step={def.step ?? 1} min={def.min} max={def.max} digits={def.type === 'int' ? 0 : 2} onCommit={onCommit} />;
}

/** Every setting of one indicator instance: parameters, style (overall and per output), timeframes, lock. */
export function IndicatorInspector({ ind, onPatch, onDelete }: { ind: Indicator; onPatch: (p: Patch, label: string) => void; onDelete: () => void }) {
  const def = INDICATORS[ind.type];
  const multi = def.outputs.length > 1;
  const allTf = ind.timeframes === 'all';
  const toggleTf = (tf: Timeframe) => {
    const cur = allTf ? [...TIMEFRAMES] : (ind.timeframes as Timeframe[]);
    const next = cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf];
    if (next.length) onPatch({ timeframes: next.length === TIMEFRAMES.length ? 'all' : next }, 'Change indicator timeframes');
  };
  const out = (key: string, o: Record<string, unknown>, label: string) => onPatch({ style: { outputs: { [key]: o } } }, label);
  return (
    <div className="ind-inspector">
      <div className="ihead">
        <span className="kind"><Activity size={15} /></span>
        <span className="name">{def.name}</span>
        {ind.origin.by === 'ai' ? <Chip tone="ai">AI</Chip> : <Chip>Manual</Chip>}
        <div className="iactions">
          <IconButton label="Remove indicator" tone="danger" disabled={ind.locked} onClick={onDelete}><Trash2 size={15} /></IconButton>
        </div>
      </div>
      {ind.origin.reason && <p className="reason"><strong>Why: </strong>{ind.origin.reason}</p>}
      {def.usesTickVolume && <div className="warn">Uses MT5 tick volume (price updates per candle), not exchange volume. Treat it as an approximation.</div>}
      {ind.locked && <div className="warn">Locked: the AI cannot change this indicator, and neither can you until you unlock it.</div>}
      <fieldset disabled={ind.locked} className="ifs">
        <Section title="Parameters">
          <Field label="Label"><CommitText label="Label" value={ind.label} max={80} onCommit={(v) => onPatch({ label: v }, 'Rename indicator')} /></Field>
          {def.params.map((p) => (
            <Field key={p.key} label={p.label}>
              <ParamField def={p} value={ind.params[p.key] ?? p.default} onCommit={(v) => onPatch({ params: { [p.key]: v } }, `Change ${p.label.toLowerCase()}`)} />
            </Field>
          ))}
        </Section>

        <Section title="Style">
          {!multi && (
            <Field label="Colour"><ColorField label="Colour" value={ind.style.color} onCommit={(v) => onPatch({ style: { color: v } }, 'Change colour')} /><span className="mono hint">{ind.style.color.toUpperCase()}</span></Field>
          )}
          <Field label="Thickness"><CommitNumber label="Thickness" value={ind.style.width} step={1} min={1} max={8} digits={0} onCommit={(v) => onPatch({ style: { width: v } }, 'Change thickness')} /></Field>
          <Field label="Line"><Segmented<'solid' | 'dashed' | 'dotted'> label="Line style" size="sm" value={ind.style.lineStyle} onChange={(v) => onPatch({ style: { lineStyle: v } }, 'Change line style')} options={[...LINES]} /></Field>
        </Section>

        <Section title={multi ? 'Outputs' : 'Output'}>
          {def.outputs.map((o) => {
            const st = outputStyle(ind, o.key);
            return (
              <div className="outrow" key={o.key}>
                <Switch label={`Show ${o.label}`} checked={st.visible} onChange={(v) => out(o.key, { visible: v }, `Toggle ${o.label}`)} />
                <span className="ilabel">{o.label}</span>
                <ColorField label={`${o.label} colour`} value={st.color} onCommit={(v) => out(o.key, { color: v }, `Change ${o.label} colour`)} />
                {o.kind === 'histogram'
                  ? <ColorField label={`${o.label} negative colour`} value={st.negColor ?? st.color} onCommit={(v) => out(o.key, { negColor: v }, `Change ${o.label} negative colour`)} />
                  : <CommitNumber label={`${o.label} thickness`} value={st.width} step={1} min={1} max={8} digits={0} onCommit={(v) => out(o.key, { width: v }, `Change ${o.label} thickness`)} />}
              </div>
            );
          })}
        </Section>

        <Section title="Visible on timeframes" action={<Switch label="All timeframes" checked={allTf} onChange={(v) => onPatch({ timeframes: v ? 'all' : ['H1'] }, 'Change indicator timeframes')} />}>
          <div className="tfgrid">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} className="tfpill" disabled={allTf} aria-pressed={allTf || (ind.timeframes as Timeframe[]).includes(tf)} onClick={() => toggleTf(tf)}>{tf}</button>
            ))}
          </div>
        </Section>
      </fieldset>
      <p className="hint">Added {new Date(ind.origin.at).toLocaleString()} by {ind.origin.by === 'ai' ? 'AI' : 'you'}.</p>
    </div>
  );
}
