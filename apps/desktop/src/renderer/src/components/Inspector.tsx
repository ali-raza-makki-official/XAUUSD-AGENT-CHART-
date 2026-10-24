import {
  TIMEFRAMES, lotsForRisk, positionIssues, rewardRisk,
  type AccountInfo, type Drawing, type SymbolSpec, type Timeframe,
} from '@aurum/core';
import { ColorField, CommitNumber, CommitText, Field } from './Fields';

type Patch = Record<string, unknown>;
interface Props {
  d: Drawing;
  pipSize: number;
  spec: SymbolSpec | null;
  account: AccountInfo | null;
  onPatch: (patch: Patch, label: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

const BLOCK: Record<string, string> = {
  invalid_input: 'Needs a balance, a risk % and a stop-loss distance.',
  below_min_volume: 'Even the minimum lot would risk more than the budget.',
  above_max_volume: 'Lot size capped at the broker maximum.',
};

function PositionFields({ d, pipSize, spec, account, onPatch }: Props & { d: Extract<Drawing, { kind: 'position' }> }) {
  const issues = positionIssues(d);
  const slDist = Math.abs(d.entry - d.stopLoss);
  const sized = account?.balance && spec ? lotsForRisk({ balance: account.balance, riskPct: d.riskPct, slDistance: slDist, spec }) : null;
  const setTp = (i: number, change: Partial<{ price: number; closePct: number }>) =>
    onPatch({ takeProfits: d.takeProfits.map((t, k) => (k === i ? { ...t, ...change } : t)) }, 'Edit take profit');
  return (
    <>
      <Field label="Side">
        <select value={d.side} aria-label="Side" onChange={(e) => onPatch({ side: e.target.value }, 'Change side')}><option value="buy">Buy</option><option value="sell">Sell</option></select>
      </Field>
      <Field label="Entry"><CommitNumber label="Entry price" value={d.entry} onCommit={(v) => onPatch({ entry: v }, 'Edit entry')} /></Field>
      <Field label="Stop loss"><CommitNumber label="Stop loss" value={d.stopLoss} onCommit={(v) => onPatch({ stopLoss: v }, 'Edit stop loss')} /></Field>
      <div className="isub">Take profits</div>
      {d.takeProfits.map((t, i) => (
        <div className="irow tp" key={i}>
          <span className="ilabel">TP{i + 1}</span>
          <CommitNumber label={`TP${i + 1} price`} value={t.price} onCommit={(v) => setTp(i, { price: v })} />
          <CommitNumber label={`TP${i + 1} close %`} value={t.closePct} step={5} min={0} max={100} digits={0} onCommit={(v) => setTp(i, { closePct: v })} />
          <span className="mono hint">{rewardRisk(d, t.price).toFixed(1)}R</span>
          <button className="btn" aria-label={`Remove TP${i + 1}`} onClick={() => onPatch({ takeProfits: d.takeProfits.filter((_, k) => k !== i) }, 'Remove take profit')}>×</button>
        </div>
      ))}
      {d.takeProfits.length < 5 && (
        <button className="btn" onClick={() => onPatch({ takeProfits: [...d.takeProfits, { price: Number((d.entry + (d.side === 'buy' ? 1 : -1) * slDist * (d.takeProfits.length + 2)).toFixed(2)), closePct: 0 }] }, 'Add take profit')}>Add TP</button>
      )}
      <div className="isub">Risk (calculated by code)</div>
      <Field label="Risk % of balance"><CommitNumber label="Risk percent" value={d.riskPct} step={0.1} min={0.01} max={100} onCommit={(v) => onPatch({ riskPct: v }, 'Edit risk %')} /></Field>
      <div className="calc mono">
        <div>SL distance {slDist.toFixed(2)} = {(slDist / pipSize).toFixed(0)} pips</div>
        {sized && !sized.blocked && (<><div>Lots {sized.lots.toFixed(2)}</div><div>Risk {sized.actualRisk.toFixed(2)} {account?.currency} of {sized.riskBudget.toFixed(2)} budget</div></>)}
        {sized?.blocked && <div className="warn">{BLOCK[sized.blocked]}</div>}
        {!sized && <div className="hint">Lot size appears once MT5 gives balance and contract specs.</div>}
      </div>
      {issues.map((m) => <div key={m} className="warn">{m}</div>)}
    </>
  );
}

export function Inspector(props: Props) {
  const { d, onPatch, onDelete, onDuplicate } = props;
  const locked = d.locked;
  const style = (s: Partial<Drawing['style']>, label: string) => onPatch({ style: s }, label);
  const tfs = d.timeframes === 'all' ? null : d.timeframes;
  const toggleTf = (tf: Timeframe) => {
    const cur = tfs ?? [...TIMEFRAMES];
    const next = cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf];
    onPatch({ timeframes: next.length === TIMEFRAMES.length ? 'all' : next }, 'Change timeframe visibility');
  };
  return (
    <div className="inspector">
      <div className="ihead">
        <strong>{d.kind === 'position' ? `${d.side === 'buy' ? 'Long' : 'Short'} position` : d.kind}</strong>
        <span className={`chip ${d.layer === 'ai' ? 'demo' : 'info'}`}>{d.layer === 'ai' ? 'AI' : 'Manual'}</span>
        {locked && <span className="chip warn">Locked</span>}
      </div>
      {d.origin.reason && <p className="reason"><strong>Why:</strong> {d.origin.reason}</p>}
      <div className="ibtns">
        <button className="btn" onClick={() => onPatch({ locked: !locked }, locked ? 'Unlock drawing' : 'Lock drawing')}>{locked ? 'Unlock' : 'Lock (AI cannot edit)'}</button>
        <button className="btn" onClick={() => onPatch({ visible: !d.visible }, d.visible ? 'Hide drawing' : 'Show drawing')}>{d.visible ? 'Hide' : 'Show'}</button>
        <button className="btn" onClick={onDuplicate}>Duplicate</button>
        <button className="btn stop" disabled={locked} onClick={onDelete}>Delete</button>
      </div>
      <fieldset disabled={locked} className="ifs">
        <Field label="Label"><CommitText label="Label" value={d.label} max={80} onCommit={(v) => onPatch({ label: v }, 'Edit label')} /></Field>
        <Field label="Show label"><input type="checkbox" checked={d.showLabel} aria-label="Show label" onChange={(e) => onPatch({ showLabel: e.target.checked }, 'Toggle label')} /></Field>
        <Field label="Note"><CommitText label="Note" value={d.note} max={1000} multiline onCommit={(v) => onPatch({ note: v }, 'Edit note')} /></Field>

        <div className="isub">Style</div>
        <Field label="Colour"><ColorField label="Colour" value={d.style.color} onCommit={(v) => style({ color: v }, 'Change colour')} /></Field>
        <Field label="Thickness"><CommitNumber label="Thickness" value={d.style.width} step={1} min={1} max={8} digits={0} onCommit={(v) => style({ width: v }, 'Change thickness')} /></Field>
        <Field label="Line">
          <select value={d.style.lineStyle} aria-label="Line style" onChange={(e) => style({ lineStyle: e.target.value as 'solid' }, 'Change line style')}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select>
        </Field>
        <Field label="Fill"><CommitNumber label="Fill opacity" value={d.style.fillOpacity} step={0.02} min={0} max={1} onCommit={(v) => style({ fillOpacity: v }, 'Change fill')} /></Field>

        <div className="isub">Geometry</div>
        {d.kind === 'hline' && <Field label="Price"><CommitNumber label="Price" value={d.price} onCommit={(v) => onPatch({ price: v }, 'Edit price')} /></Field>}
        {(d.kind === 'ray' || d.kind === 'trendline' || d.kind === 'zone' || d.kind === 'fib' || d.kind === 'measure' || d.kind === 'channel') && (
          <>
            <Field label={d.kind === 'zone' ? 'Top/Start price' : 'Start price'}><CommitNumber label="Start price" value={d.a.price} onCommit={(v) => onPatch({ a: { ...d.a, price: v } }, 'Edit price')} /></Field>
            <Field label={d.kind === 'zone' ? 'Bottom/End price' : 'End price'}><CommitNumber label="End price" value={d.b.price} onCommit={(v) => onPatch({ b: { ...d.b, price: v } }, 'Edit price')} /></Field>
          </>
        )}
        {d.kind === 'trendline' && (
          <Field label="Extend"><select value={d.extend} aria-label="Extend" onChange={(e) => onPatch({ extend: e.target.value }, 'Change extension')}><option value="none">None</option><option value="right">Right</option><option value="both">Both</option></select></Field>
        )}
        {d.kind === 'zone' && (
          <>
            <Field label="Type"><select value={d.zoneType} aria-label="Zone type" onChange={(e) => onPatch({ zoneType: e.target.value }, 'Change zone type')}>{['support', 'resistance', 'supply', 'demand', 'custom'].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
            <Field label="Extend right"><input type="checkbox" checked={d.extendRight} aria-label="Extend right" onChange={(e) => onPatch({ extendRight: e.target.checked }, 'Toggle extension')} /></Field>
          </>
        )}
        {d.kind === 'fib' && (
          <>
            <Field label="Extend right"><input type="checkbox" checked={d.extendRight} aria-label="Extend right" onChange={(e) => onPatch({ extendRight: e.target.checked }, 'Toggle extension')} /></Field>
            <div className="isub">Levels</div>
            {d.levels.map((l, i) => (
              <div className="irow tp" key={i}>
                <input type="checkbox" checked={l.visible} aria-label={`Show level ${l.ratio}`} onChange={(e) => onPatch({ levels: d.levels.map((x, k) => (k === i ? { ...x, visible: e.target.checked } : x)) }, 'Toggle fib level')} />
                <CommitNumber label={`Level ${i + 1} ratio`} value={l.ratio} step={0.001} digits={3} onCommit={(v) => onPatch({ levels: d.levels.map((x, k) => (k === i ? { ...x, ratio: v } : x)) }, 'Edit fib level')} />
                <ColorField label={`Level ${l.ratio} colour`} value={l.color ?? d.style.color} onCommit={(v) => onPatch({ levels: d.levels.map((x, k) => (k === i ? { ...x, color: v } : x)) }, 'Edit fib colour')} />
                <button className="btn" aria-label={`Remove level ${l.ratio}`} onClick={() => onPatch({ levels: d.levels.filter((_, k) => k !== i) }, 'Remove fib level')}>×</button>
              </div>
            ))}
            <button className="btn" onClick={() => onPatch({ levels: [...d.levels, { ratio: 0.9, visible: true }] }, 'Add fib level')}>Add level</button>
          </>
        )}
        {d.kind === 'text' && <Field label="Text"><CommitText label="Text" value={d.text} max={500} multiline onCommit={(v) => onPatch({ text: v }, 'Edit text')} /></Field>}
        {d.kind === 'position' && <PositionFields {...props} d={d} />}

        <div className="isub">Visible on timeframes</div>
        <div className="tfchecks">
          <label><input type="checkbox" checked={d.timeframes === 'all'} onChange={() => onPatch({ timeframes: d.timeframes === 'all' ? ['H1'] : 'all' }, 'Change timeframe visibility')} /> All</label>
          {TIMEFRAMES.map((tf) => (
            <label key={tf}><input type="checkbox" disabled={d.timeframes === 'all'} checked={d.timeframes === 'all' || d.timeframes.includes(tf)} onChange={() => toggleTf(tf)} /> {tf}</label>
          ))}
        </div>
      </fieldset>
      <p className="hint">Created {new Date(d.origin.at).toLocaleString()} by {d.origin.by === 'ai' ? 'AI' : 'you'}.</p>
    </div>
  );
}
