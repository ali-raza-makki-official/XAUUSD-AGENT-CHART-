import { useState } from 'react';
import type { Drawing } from '@aurum/core';

const summary = (d: Drawing): string => {
  switch (d.kind) {
    case 'hline': return d.price.toFixed(2);
    case 'vline': return new Date(d.time * 1000).toISOString().slice(0, 16).replace('T', ' ');
    case 'position': return `${d.side} @ ${d.entry.toFixed(2)}`;
    case 'text': return d.text.slice(0, 24);
    case 'zone': return `${d.a.price.toFixed(2)}–${d.b.price.toFixed(2)}`;
    default: return `${d.a.price.toFixed(2)} → ${d.b.price.toFixed(2)}`;
  }
};

interface Props {
  drawings: Drawing[];
  selectedId: string | null;
  hiddenLayers: { manual: boolean; ai: boolean };
  onHideLayer: (l: 'manual' | 'ai') => void;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Record<string, unknown>, label: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

export function ObjectsPanel({ drawings, selectedId, hiddenLayers, onHideLayer, onSelect, onPatch, onDelete, onClear }: Props) {
  const [confirm, setConfirm] = useState(false);
  const sorted = [...drawings].sort((a, b) => b.origin.at - a.origin.at);
  return (
    <div className="objects">
      <div className="ibtns">
        <button className="btn" aria-pressed={!hiddenLayers.manual} onClick={() => onHideLayer('manual')}>{hiddenLayers.manual ? 'Show' : 'Hide'} manual layer</button>
        <button className="btn" aria-pressed={!hiddenLayers.ai} onClick={() => onHideLayer('ai')}>{hiddenLayers.ai ? 'Show' : 'Hide'} AI layer</button>
      </div>
      {sorted.length === 0 && <p className="hint">No drawings yet. Pick a tool on the left and click on the chart.</p>}
      <ul className="olist">
        {sorted.map((d) => (
          <li key={d.id} className={d.id === selectedId ? 'sel' : ''}>
            <button className="orow" onClick={() => onSelect(d.id)}>
              <span className={`chip ${d.layer === 'ai' ? 'demo' : 'info'}`}>{d.layer === 'ai' ? 'AI' : 'You'}</span>
              <span className="oname">{d.label || d.kind}</span>
              <span className="mono hint">{summary(d)}</span>
            </button>
            <button className="btn" aria-label={d.visible ? 'Hide drawing' : 'Show drawing'} title={d.visible ? 'Hide' : 'Show'} onClick={() => onPatch(d.id, { visible: !d.visible }, d.visible ? 'Hide drawing' : 'Show drawing')}>{d.visible ? '◉' : '○'}</button>
            <button className="btn" aria-label={d.locked ? 'Unlock drawing' : 'Lock drawing'} title={d.locked ? 'Unlock' : 'Lock'} onClick={() => onPatch(d.id, { locked: !d.locked }, d.locked ? 'Unlock drawing' : 'Lock drawing')}>{d.locked ? 'Locked' : 'Lock'}</button>
            <button className="btn" aria-label="Delete drawing" disabled={d.locked} onClick={() => onDelete(d.id)}>×</button>
          </li>
        ))}
      </ul>
      {sorted.length > 0 && (
        confirm ? (
          <div className="confirm"><span>Delete all {sorted.filter((d) => !d.locked).length} unlocked drawings?</span><button className="btn" onClick={() => setConfirm(false)} autoFocus>Cancel</button><button className="btn stop" onClick={() => { onClear(); setConfirm(false); }}>Delete all</button></div>
        ) : <button className="btn" onClick={() => setConfirm(true)}>Delete all drawings…</button>
      )}
    </div>
  );
}
