import { Copy, Eye, EyeOff, Lock, LockOpen, Plus, Trash2, X, MousePointerClick } from 'lucide-react';
import {
  TIMEFRAMES, lotsForRisk, positionIssues, rewardRisk,
  type AccountInfo, type Drawing, type SymbolSpec, type Timeframe,
} from '@aurum/core';
import { ColorField, CommitNumber, CommitText, Field } from './Fields';
import { kindIcon, kindName } from '../lib/toolIcons';
import { DrawingAlertAction } from './AlertsPanel';
import type { AurumApi } from '../../../shared';
import { Button, Chip, EmptyState, IconButton, Section, Segmented, Switch } from './ui';

type Patch = Record<string, unknown>;
interface Props {
  d: Drawing;
  pipSize: number;
  spec: SymbolSpec | null;
  account: AccountInfo | null;
  onPatch: (patch: Patch, label: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Opens the order confirm flow for a long/short plan. Absent when trading is not enabled. */
  onPlaceOrder?: () => void;
  api?: AurumApi;
  price?: number | null;
}

const BLOCK: Record<string, string> = {
  invalid_input: 'Needs a balance, a risk % and a stop-loss distance.',
  below_min_volume: 'Even the minimum lot would risk more than the budget.',
  above_max_volume: 'Lot size capped at the broker maximum.',
};

export const InspectorEmpty = () => (
  <div className="panel-pad"><EmptyState icon={MousePointerClick} title="Nothing selected">Click a drawing on the chart or in the Objects list to edit every setting of it.</EmptyState></div>
);

function PositionFields({ d, pipSize, spec, account, onPatch }: Props & { d: Extract<Drawing, { kind: 'position' }> }) {
  const issues = positionIssues(d);
  const slDist = Math.abs(d.entry - d.stopLoss);
  const sized = account?.balance && spec ? lotsForRisk({ balance: account.balance, riskPct: d.riskPct, slDistance: slDist, spec }) : null;
  const setTp = (i: number, change: Partial<{ price: number; closePct: number }>) =>
    onPatch({ takeProfits: d.takeProfits.map((t, k) => (k === i ? { ...t, ...change } : t)) }, 'Edit take profit');
  return (
    <>
      <Section title="Trade plan">
        <Field label="Side"><Segmented<'buy' | 'sell'> label="Side" size="sm" value={d.side} onChange={(v) => onPatch({ side: v }, 'Change side')} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} /></Field>
        <Field label="Entry"><CommitNumber label="Entry price" value={d.entry} onCommit={(v) => onPatch({ entry: v }, 'Edit entry')} /></Field>
        <Field label="Stop loss"><CommitNumber label="Stop loss" value={d.stopLoss} onCommit={(v) => onPatch({ stopLoss: v }, 'Edit stop loss')} /></Field>
        <div className="irow tp hint" aria-hidden="true"><span /><span>Price</span><span>Close %</span><span>R</span><span /></div>
        {d.takeProfits.map((t, i) => (
          <div className="irow tp" key={i}>
            <span className="ilabel">TP{i + 1}</span>
            <CommitNumber label={`TP${i + 1} price`} value={t.price} onCommit={(v) => setTp(i, { price: v })} />
            <CommitNumber label={`TP${i + 1} close %`} value={t.closePct} step={5} min={0} max={100} digits={0} onCommit={(v) => setTp(i, { closePct: v })} />
            <span className="mono hint">{rewardRisk(d, t.price).toFixed(1)}</span>
            <IconButton label={`Remove TP${i + 1}`} tone="danger" onClick={() => onPatch({ takeProfits: d.takeProfits.filter((_, k) => k !== i) }, 'Remove take profit')}><X size={14} /></IconButton>
          </div>
        ))}
        {d.takeProfits.length < 5 && (
          <Button size="sm" icon={Plus} onClick={() => onPatch({ takeProfits: [...d.takeProfits, { price: Number((d.entry + (d.side === 'buy' ? 1 : -1) * slDist * (d.takeProfits.length + 2)).toFixed(2)), closePct: 0 }] }, 'Add take profit')}>Add take profit</Button>
        )}
        {issues.map((m) => <div key={m} className="warn">{m}</div>)}
      </Section>
      <Section title="Risk (calculated by code)">
        <Field label="Risk % of balance"><CommitNumber label="Risk percent" value={d.riskPct} step={0.1} min={0.01} max={100} onCommit={(v) => onPatch({ riskPct: v }, 'Edit risk %')} /></Field>
        <div className="calc mono">
          <div><span className="k">SL distance </span>{slDist.toFixed(2)} · {(slDist / pipSize).toFixed(0)} pips</div>
          {sized && !sized.blocked && (<><div><span className="k">Lot size </span>{sized.lots.toFixed(2)}</div><div><span className="k">Risk </span>{sized.actualRisk.toFixed(2)} {account?.currency} of {sized.riskBudget.toFixed(2)} budget</div></>)}
          {sized?.blocked && <div className="warn">{BLOCK[sized.blocked]}</div>}
          {!sized && <div className="hint">Lot size appears once MT5 provides balance and contract specs.</div>}
        </div>
      </Section>
    </>
  );
}

export function Inspector(props: Props) {
  const { d, onPatch, onDelete, onDuplicate } = props;
  const locked = d.locked;
  const style = (s: Partial<Drawing['style']>, label: string) => onPatch({ style: s }, label);
  const allTf = d.timeframes === 'all';
  const toggleTf = (tf: Timeframe) => {
    const cur = allTf ? [...TIMEFRAMES] : (d.timeframes as Timeframe[]);
    const next = cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf];
    if (next.length) onPatch({ timeframes: next.length === TIMEFRAMES.length ? 'all' : next }, 'Change timeframe visibility');
  };
  const name = kindName(d);
  return (
    <div className="panel-pad">
      <div className="ihead">
        <span className="kind">{kindIcon(d)}</span>
        <span className="name">{name}</span>
        {d.layer === 'ai' ? <Chip tone="ai">AI</Chip> : <Chip>Manual</Chip>}
        <div className="iactions">
          <IconButton label={locked ? 'Unlock' : 'Lock (AI cannot edit)'} pressed={locked} onClick={() => onPatch({ locked: !locked }, locked ? 'Unlock drawing' : 'Lock drawing')}>{locked ? <Lock size={15} /> : <LockOpen size={15} />}</IconButton>
          <IconButton label={d.visible ? 'Hide' : 'Show'} onClick={() => onPatch({ visible: !d.visible }, d.visible ? 'Hide drawing' : 'Show drawing')}>{d.visible ? <Eye size={15} /> : <EyeOff size={15} />}</IconButton>
          <IconButton label="Duplicate  (Ctrl+D)" onClick={onDuplicate}><Copy size={15} /></IconButton>
          <IconButton label="Delete  (Del)" tone="danger" disabled={locked} onClick={onDelete}><Trash2 size={15} /></IconButton>
        </div>
      </div>
      {d.origin.reason && <p className="reason"><strong>Why: </strong>{d.origin.reason}</p>}
      {locked && <div className="warn">Locked: the AI cannot change this drawing, and neither can you until you unlock it.</div>}

      <fieldset disabled={locked} className="ifs">
        <Section title="General">
          <Field label="Label"><CommitText label="Label" value={d.label} max={80} onCommit={(v) => onPatch({ label: v }, 'Edit label')} /></Field>
          <Field label="Show label"><Switch label="Show label" checked={d.showLabel} onChange={(v) => onPatch({ showLabel: v }, 'Toggle label')} /></Field>
          <Field label="Note"><CommitText label="Note" value={d.note} max={1000} multiline onCommit={(v) => onPatch({ note: v }, 'Edit note')} /></Field>
        </Section>

        <Section title="Style">
          <Field label="Colour"><ColorField label="Colour" value={d.style.color} onCommit={(v) => style({ color: v }, 'Change colour')} /><span className="mono hint">{d.style.color.toUpperCase()}</span></Field>
          <Field label="Thickness"><CommitNumber label="Thickness" value={d.style.width} step={1} min={1} max={8} digits={0} onCommit={(v) => style({ width: v }, 'Change thickness')} /></Field>
          <Field label="Line"><Segmented<'solid' | 'dashed' | 'dotted'> label="Line style" size="sm" value={d.style.lineStyle} onChange={(v) => style({ lineStyle: v }, 'Change line style')} options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }]} /></Field>
          <Field label="Fill"><CommitNumber label="Fill opacity" value={d.style.fillOpacity} step={0.02} min={0} max={1} onCommit={(v) => style({ fillOpacity: v }, 'Change fill')} /></Field>
        </Section>

        {d.kind !== 'position' && (
          <Section title="Geometry">
            {d.kind === 'hline' && <Field label="Price"><CommitNumber label="Price" value={d.price} onCommit={(v) => onPatch({ price: v }, 'Edit price')} /></Field>}
            {(d.kind === 'ray' || d.kind === 'trendline' || d.kind === 'zone' || d.kind === 'fib' || d.kind === 'measure' || d.kind === 'channel') && (
              <>
                <Field label={d.kind === 'zone' ? 'Top price' : 'Start price'}><CommitNumber label="Start price" value={d.a.price} onCommit={(v) => onPatch({ a: { ...d.a, price: v } }, 'Edit price')} /></Field>
                <Field label={d.kind === 'zone' ? 'Bottom price' : 'End price'}><CommitNumber label="End price" value={d.b.price} onCommit={(v) => onPatch({ b: { ...d.b, price: v } }, 'Edit price')} /></Field>
              </>
            )}
            {d.kind === 'trendline' && (
              <Field label="Extend"><Segmented<'none' | 'right' | 'both'> label="Extend" size="sm" value={d.extend} onChange={(v) => onPatch({ extend: v }, 'Change extension')} options={[{ value: 'none', label: 'None' }, { value: 'right', label: 'Right' }, { value: 'both', label: 'Both' }]} /></Field>
            )}
            {d.kind === 'zone' && (
              <>
                <Field label="Type"><select className="select" value={d.zoneType} aria-label="Zone type" onChange={(e) => onPatch({ zoneType: e.target.value }, 'Change zone type')}>{['support', 'resistance', 'supply', 'demand', 'custom'].map((z) => <option key={z} value={z}>{z[0]!.toUpperCase() + z.slice(1)}</option>)}</select></Field>
                <Field label="Extend right"><Switch label="Extend right" checked={d.extendRight} onChange={(v) => onPatch({ extendRight: v }, 'Toggle extension')} /></Field>
              </>
            )}
            {d.kind === 'text' && <Field label="Text"><CommitText label="Text" value={d.text} max={500} multiline onCommit={(v) => onPatch({ text: v }, 'Edit text')} /></Field>}
          </Section>
        )}

        {d.kind === 'fib' && (
          <Section title="Levels" action={<Switch label="Extend right" checked={d.extendRight} onChange={(v) => onPatch({ extendRight: v }, 'Toggle extension')} />}>
            {d.levels.map((l, i) => (
              <div className="irow lv" key={i}>
                <Switch label={`Show level ${l.ratio}`} checked={l.visible} onChange={(v) => onPatch({ levels: d.levels.map((x, k) => (k === i ? { ...x, visible: v } : x)) }, 'Toggle fib level')} />
                <CommitNumber label={`Level ${i + 1} ratio`} value={l.ratio} step={0.001} digits={3} onCommit={(v) => onPatch({ levels: d.levels.map((x, k) => (k === i ? { ...x, ratio: v } : x)) }, 'Edit fib level')} />
                <ColorField label={`Level ${l.ratio} colour`} value={l.color ?? d.style.color} onCommit={(v) => onPatch({ levels: d.levels.map((x, k) => (k === i ? { ...x, color: v } : x)) }, 'Edit fib colour')} />
                <IconButton label={`Remove level ${l.ratio}`} tone="danger" onClick={() => onPatch({ levels: d.levels.filter((_, k) => k !== i) }, 'Remove fib level')}><X size={14} /></IconButton>
              </div>
            ))}
            <Button size="sm" icon={Plus} onClick={() => onPatch({ levels: [...d.levels, { ratio: 0.9, visible: true }] }, 'Add fib level')}>Add level</Button>
          </Section>
        )}

        {d.kind === 'position' && <PositionFields {...props} d={d} />}
        {d.kind === 'position' && props.onPlaceOrder && (
          <Section title="Order">
            <Button variant="primary" onClick={props.onPlaceOrder}>Place this order…</Button>
            <span className="hint">Opens a review: lot size from your risk %, the stop loss and the exact risk. Nothing is sent until you confirm there.</span>
          </Section>
        )}

        <DrawingAlertAction api={props.api} d={d} price={props.price ?? null} />

        <Section title="Visible on timeframes" action={<Switch label="All timeframes" checked={allTf} onChange={(v) => onPatch({ timeframes: v ? 'all' : ['H1'] }, 'Change timeframe visibility')} />}>
          <div className="tfgrid">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} className="tfpill" disabled={allTf} aria-pressed={allTf || (d.timeframes as Timeframe[]).includes(tf)} onClick={() => toggleTf(tf)}>{tf}</button>
            ))}
          </div>
        </Section>
      </fieldset>
      <p className="hint">Created {new Date(d.origin.at).toLocaleString()} by {d.origin.by === 'ai' ? 'AI' : 'you'}.</p>
    </div>
  );
}
