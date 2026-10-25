import { useState, type ReactNode } from 'react';
import { Bell, BookOpen, Briefcase, Globe2, ChevronDown, ChevronUp, History, ListChecks, ScrollText, Undo2, type LucideIcon } from 'lucide-react';
import type { LogLine } from '../hooks';
import { EmptyState, IconButton, Button } from './ui';
import { ContextPanel } from './ContextPanel';
import { AlertsPanel } from './AlertsPanel';
import type { AppConfig } from '@aurum/core';
import type { AurumApi } from '../../../shared';

const TABS: { id: string; label: string; icon: LucideIcon; empty: string }[] = [
  { id: 'context', label: 'Context', icon: Globe2, empty: '' },
  { id: 'feed', label: 'Feed log', icon: ScrollText, empty: 'No feed events yet.' },
  { id: 'positions', label: 'Positions', icon: Briefcase, empty: 'No open positions.' },
  { id: 'alerts', label: 'Alerts', icon: Bell, empty: 'No alerts yet. Alerts and schedules will appear here.' },
  { id: 'setups', label: 'Setups', icon: ListChecks, empty: 'No saved setups yet.' },
  { id: 'journal', label: 'Journal', icon: BookOpen, empty: 'The trade journal is empty.' },
  { id: 'ai', label: 'AI actions', icon: History, empty: 'Every AI action will be listed here, each one undoable.' },
];

const LEVEL = (t: string) => (/^(DISCONNECTED|ERROR)/.test(t) ? 'var(--sell)' : /^STALE/.test(t) ? 'var(--warn)' : /^CONNECTED/.test(t) ? 'var(--buy)' : 'var(--t2)');

export interface AiAction { at: number; label: string }

export function BottomPanel({ log, aiActions, onUndoAllAi, api, config, positions }: { log: LogLine[]; aiActions: AiAction[]; onUndoAllAi: () => void; api?: AurumApi; config?: AppConfig | null; positions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('feed');
  const cur = TABS.find((t) => t.id === tab)!;
  return (
    <section className="bottom" aria-label="Activity panel">
      <div className="btabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className="btab" aria-selected={t.id === tab} onClick={() => { setTab(t.id); setOpen(true); }}>
            <t.icon size={14} strokeWidth={1.8} aria-hidden="true" />{t.label}
          </button>
        ))}
        <span className="spacer" />
        <IconButton label={open ? 'Collapse panel' : 'Expand panel'} pos="top" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </IconButton>
      </div>
      {open && (
        <div className="content" role="tabpanel" style={undefined}>
          {tab === 'alerts' && <AlertsPanel api={api} config={config} />}
          {tab === 'positions' && positions}
          {tab === 'context' && <ContextPanel api={api} config={config ?? null} />}
          {tab === 'feed' && log.length ? (
            <div className="log">{log.map((l, i) => {
              const [lvl, ...rest] = l.text.split(' — ');
              return <div key={i}><span className="t">{new Date(l.at).toLocaleTimeString()}</span><span className="lvl" style={{ color: LEVEL(l.text) }}>{lvl}</span>{rest.join(' — ')}</div>;
            })}</div>
          ) : tab === 'ai' && aiActions.length ? (
            <div>
              <div className="row" style={{ marginBottom: 6 }}><Button size="sm" icon={Undo2} onClick={onUndoAllAi}>Undo all AI changes today</Button></div>
              <div className="log">{[...aiActions].reverse().map((a, i) => <div key={i}><span className="t">{new Date(a.at).toLocaleTimeString()}</span>{a.label}</div>)}</div>
            </div>
          ) : tab !== 'context' && tab !== 'alerts' && <EmptyState icon={cur.icon} title={cur.empty} />}
        </div>
      )}
    </section>
  );
}
