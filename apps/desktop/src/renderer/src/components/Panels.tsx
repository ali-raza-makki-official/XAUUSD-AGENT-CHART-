import { useState } from 'react';
import { Bell, BookOpen, Bot, ChevronDown, ChevronUp, History, ListChecks, ScrollText, SendHorizontal, type LucideIcon } from 'lucide-react';
import type { LogLine } from '../hooks';
import { Chip, EmptyState, IconButton, Button } from './ui';

export function ChatPanel() {
  return (
    <div className="chat" aria-label="AI chat">
      <div className="body">
        <EmptyState icon={Bot} title="AI assistant not connected">
          Add an AI provider in Settings and it will read this chart, your drawings and the live feed, and be able to draw and analyse for you.
          <div style={{ marginTop: 10 }}><Chip tone="ai">Read-only until you allow more</Chip></div>
        </EmptyState>
      </div>
      <div className="composer">
        <textarea className="textarea" disabled placeholder="Connect an AI provider to start" aria-label="Message to AI" />
        <Button variant="primary" icon={SendHorizontal} disabled aria-label="Send">Send</Button>
      </div>
    </div>
  );
}

const TABS: { id: string; label: string; icon: LucideIcon; empty: string }[] = [
  { id: 'feed', label: 'Feed log', icon: ScrollText, empty: 'No feed events yet.' },
  { id: 'alerts', label: 'Alerts', icon: Bell, empty: 'No alerts yet. Alerts and schedules will appear here.' },
  { id: 'setups', label: 'Setups', icon: ListChecks, empty: 'No saved setups yet.' },
  { id: 'journal', label: 'Journal', icon: BookOpen, empty: 'The trade journal is empty.' },
  { id: 'ai', label: 'AI actions', icon: History, empty: 'Every AI action will be listed here, each one undoable.' },
];

const LEVEL = (t: string) => (/^(DISCONNECTED|ERROR)/.test(t) ? 'var(--sell)' : /^STALE/.test(t) ? 'var(--warn)' : /^CONNECTED/.test(t) ? 'var(--buy)' : 'var(--t2)');

export function BottomPanel({ log }: { log: LogLine[] }) {
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
        <div className="content" role="tabpanel">
          {tab === 'feed' && log.length ? (
            <div className="log">{log.map((l, i) => {
              const [lvl, ...rest] = l.text.split(' — ');
              return <div key={i}><span className="t">{new Date(l.at).toLocaleTimeString()}</span><span className="lvl" style={{ color: LEVEL(l.text) }}>{lvl}</span>{rest.join(' — ')}</div>;
            })}</div>
          ) : <EmptyState icon={cur.icon} title={cur.empty} />}
        </div>
      )}
    </section>
  );
}
