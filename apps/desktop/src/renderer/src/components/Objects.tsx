import { useState } from 'react';
import { Eye, EyeOff, Layers, Lock, LockOpen, Trash2, Sparkles, User } from 'lucide-react';
import type { Drawing } from '@aurum/core';
import { kindIcon, kindName } from '../lib/toolIcons';
import { Button, EmptyState, IconButton } from './ui';

const summary = (d: Drawing): string => {
  switch (d.kind) {
    case 'hline': return d.price.toFixed(2);
    case 'vline': return new Date(d.time * 1000).toISOString().slice(5, 16).replace('T', ' ');
    case 'position': return `${d.side} ${d.entry.toFixed(2)}`;
    case 'text': return d.text.slice(0, 18);
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
  const n = (l: 'manual' | 'ai') => drawings.filter((d) => d.layer === l).length;
  return (
    <div className="panel-pad">
      <div className="layers">
        <button className="layerbtn" aria-pressed={!hiddenLayers.manual} onClick={() => onHideLayer('manual')} title={hiddenLayers.manual ? 'Show manual layer' : 'Hide manual layer'}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><User size={14} aria-hidden="true" />Manual <span className="count">{n('manual')}</span></span>
          {hiddenLayers.manual ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button className="layerbtn" aria-pressed={!hiddenLayers.ai} onClick={() => onHideLayer('ai')} title={hiddenLayers.ai ? 'Show AI layer' : 'Hide AI layer'}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: 'var(--ai)' }}><Sparkles size={14} aria-hidden="true" />AI <span className="count">{n('ai')}</span></span>
          {hiddenLayers.ai ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState icon={Layers} title="No drawings yet">Pick a tool on the left and click on the chart. Anything you or the AI draws is listed here.</EmptyState>
      ) : (
        <ul className="olist">
          {sorted.map((d) => (
            <li key={d.id} className={`oitem ${d.layer} ${d.id === selectedId ? 'sel' : ''}`}>
              <button className="orow" onClick={() => onSelect(d.id)}>
                <span className="ic">{kindIcon(d)}</span>
                <span className="oname">{d.label || kindName(d)}</span>
                <span className="ometa">{summary(d)}</span>
              </button>
              <IconButton label={d.visible ? 'Hide drawing' : 'Show drawing'} pos="left" onClick={() => onPatch(d.id, { visible: !d.visible }, d.visible ? 'Hide drawing' : 'Show drawing')}>{d.visible ? <Eye size={15} /> : <EyeOff size={15} />}</IconButton>
              <IconButton label={d.locked ? 'Unlock drawing' : 'Lock drawing'} pos="left" pressed={d.locked} onClick={() => onPatch(d.id, { locked: !d.locked }, d.locked ? 'Unlock drawing' : 'Lock drawing')}>{d.locked ? <Lock size={15} /> : <LockOpen size={15} />}</IconButton>
              <IconButton label="Delete drawing" pos="left" tone="danger" disabled={d.locked} onClick={() => onDelete(d.id)}><Trash2 size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      {sorted.length > 0 && (confirm ? (
        <div className="confirm">
          <span>Delete all {sorted.filter((d) => !d.locked).length} unlocked drawings?</span>
          <Button size="sm" onClick={() => setConfirm(false)} autoFocus>Cancel</Button>
          <Button size="sm" variant="danger" onClick={() => { onClear(); setConfirm(false); }}>Delete all</Button>
        </div>
      ) : <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)}>Delete all drawings…</Button>)}
    </div>
  );
}
