import { useState } from 'react';
import type { LogLine } from '../hooks';

export function ChatPanel() {
  return (
    <div className="chat" aria-label="AI chat" style={{ height: '100%' }}>
      <div className="panel-h">AI assistant <span className="chip info">not connected</span></div>
      <div className="body">
        <p>The AI assistant is not connected yet. Once a provider is added in Settings, it will read this chart and its drawings and answer here.</p>
      </div>
      <div className="input">
        <textarea rows={2} disabled placeholder="Connect an AI provider to start" aria-label="Message" />
        <button className="btn primary" disabled>Send</button>
      </div>
    </div>
  );
}

const TABS = ['Feed log', 'Alerts', 'Setups', 'Journal', 'AI actions'] as const;

export function BottomPanel({ log }: { log: LogLine[] }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Feed log');
  return (
    <section className="bottom" aria-label="Activity panel">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" className="tab" aria-selected={t === tab} onClick={() => { setTab(t); setOpen(true); }}>{t}</button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Collapse' : 'Expand'}</button>
      </div>
      {open && (
        <div className="content" role="tabpanel">
          {tab === 'Feed log' ? (
            log.length ? (
              <div className="log">{log.map((l, i) => (<div key={i}><span className="t">{new Date(l.at).toLocaleTimeString()}</span>{l.text}</div>))}</div>
            ) : (<p>No feed events yet.</p>)
          ) : (<p>No {tab.toLowerCase()} yet.</p>)}
        </div>
      )}
    </section>
  );
}
