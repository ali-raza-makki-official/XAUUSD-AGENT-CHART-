import { Splitter } from './Splitter';
import { SIZE_LIMITS } from '../lib/panelSizes';
import { useState, type ReactNode } from 'react';
import { Crosshair, Maximize2, Minimize2, Bell, BookOpen, Brain, HeartPulse, Briefcase, Globe2, ChevronDown, ChevronUp, History, Scale, ScrollText, Undo2, type LucideIcon } from 'lucide-react';
import type { LogLine } from '../hooks';
import { EmptyState, IconButton, Button } from './ui';
import { ContextPanel } from './ContextPanel';
import { AlertsPanel } from './AlertsPanel';
import { JournalPanel } from './JournalPanel';
import { ViewsPanel } from './ViewsPanel';
import { PlansPanel } from './Assistant';
import { LearningPanel } from './LearningPanel';
import { HealthPanel } from './HealthPanel';
import type { AppConfig } from '@aurum/core';
import type { AurumApi } from '../../../shared';

const TABS: { id: string; label: string; icon: LucideIcon; empty: string }[] = [
  { id: 'context', label: 'Context', icon: Globe2, empty: '' },
  { id: 'feed', label: 'Feed log', icon: ScrollText, empty: 'No feed events yet.' },
  { id: 'positions', label: 'Positions', icon: Briefcase, empty: 'No open positions.' },
  { id: 'plans', label: 'Plans', icon: Crosshair, empty: '' },
  { id: 'alerts', label: 'Alerts', icon: Bell, empty: 'No alerts yet. Alerts and schedules will appear here.' },
  { id: 'views', label: 'My view vs AI', icon: Scale, empty: '' },
  { id: 'journal', label: 'Journal', icon: BookOpen, empty: 'The trade journal is empty.' },
  { id: 'health', label: 'Health', icon: HeartPulse, empty: '' },
  { id: 'learning', label: 'Learning', icon: Brain, empty: '' },
  { id: 'ai', label: 'AI actions', icon: History, empty: 'Every AI action will be listed here, each one undoable.' },
];

const LEVEL = (t: string) => (/^(DISCONNECTED|ERROR)/.test(t) ? 'var(--sell)' : /^STALE/.test(t) ? 'var(--warn)' : /^CONNECTED/.test(t) ? 'var(--buy)' : 'var(--t2)');

export interface AiAction { at: number; label: string }

export function BottomPanel({ feed, log, aiActions, onUndoAllAi, api, config, positions, full, onFull, height, onHeight, onResetHeight, tf, onAskAi, onSettings }: { feed?: { status: import('@aurum/core').FeedStatus; tick: import('@aurum/core').Tick | null; account: import('@aurum/core').AccountInfo | null }; onSettings?: () => void; tf?: import('@aurum/core').Timeframe; onAskAi?: (text: string) => void; full?: boolean; onFull?: () => void; height?: number; onHeight?: (h: number) => void; onResetHeight?: () => void; log: LogLine[]; aiActions: AiAction[]; onUndoAllAi: () => void; api?: AurumApi; config?: AppConfig | null; positions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('feed');
  const cur = TABS.find((t) => t.id === tab)!;
  return (
    <section className="bottom" aria-label="Activity panel">
      {open && !full && height !== undefined && onHeight && <Splitter orientation="h" label="Resize the bottom panel" value={height} min={SIZE_LIMITS.bottomH.min} max={Math.min(SIZE_LIMITS.bottomH.max, Math.round(window.innerHeight * 0.7))} grow="start" onChange={onHeight} onReset={() => onResetHeight?.()} />}
      <div className="btabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className="btab" aria-selected={t.id === tab} onClick={() => { setTab(t.id); setOpen(true); }}>
            <t.icon size={14} strokeWidth={1.8} aria-hidden="true" />{t.label}
          </button>
        ))}
        <span className="spacer" />
        {onFull && <IconButton label={full ? 'Exit full screen (Esc)' : 'Full screen'} pos="left" onClick={onFull}>{full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</IconButton>}
        {!full && <IconButton label={open ? 'Collapse panel' : 'Expand panel'} pos="top" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </IconButton>}
      </div>
      {(open || full) && (
        <div className="content" role="tabpanel" style={undefined}>
          {tab === 'alerts' && <AlertsPanel api={api} config={config} />}
          {tab === 'positions' && positions}
          {tab === 'plans' && <PlansPanel api={api} enabled={!!config?.assistant.enabled} onSettings={() => onSettings?.()} />}
          {tab === 'journal' && <JournalPanel api={api} config={config} />}
          {tab === 'views' && <ViewsPanel api={api} tf={tf ?? 'H1'} onAskAi={(t) => onAskAi?.(t)} />}
          {tab === 'health' && feed && <HealthPanel api={api} config={config} status={feed.status} tick={feed.tick} account={feed.account} />}
          {tab === 'learning' && <LearningPanel api={api} config={config} />}
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
          ) : tab !== 'context' && tab !== 'alerts' && tab !== 'journal' && tab !== 'views' && tab !== 'plans' && tab !== 'learning' && tab !== 'health' && <EmptyState icon={cur.icon} title={cur.empty} />}
        </div>
      )}
    </section>
  );
}
