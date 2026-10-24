import { TIMEFRAMES, type AccountInfo, type AppConfig, type FeedStatus, type Tick, type Timeframe } from '@aurum/core';

const STATUS: Record<FeedStatus['state'], { cls: string; icon: string; text: string }> = {
  connected: { cls: 'ok', icon: '●', text: 'MT5 connected' },
  stale: { cls: 'warn', icon: '◐', text: 'Stale data' },
  starting: { cls: 'info', icon: '…', text: 'Connecting' },
  disconnected: { cls: 'err', icon: '○', text: 'Disconnected' },
  error: { cls: 'err', icon: '✕', text: 'Error' },
};

const f2 = (n: number) => n.toFixed(2);

interface Props {
  config: AppConfig | null;
  tf: Timeframe;
  onTf: (tf: Timeframe) => void;
  tick: Tick | null;
  status: FeedStatus;
  account: AccountInfo | null;
  saveError: string | null;
  onSettings: () => void;
}

export function TopBar({ config, tf, onTf, tick, status, account, saveError, onSettings }: Props) {
  const st = STATUS[status.state];
  const pip = config?.pipSize ?? 0.1;
  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 14v36M32 10v30M44 18v32" stroke="#7D8590" strokeWidth="3" strokeLinecap="round"/><rect x="15" y="24" width="10" height="16" rx="2" fill="#2A3038"/><rect x="39" y="26" width="10" height="14" rx="2" fill="#2A3038"/><rect x="27" y="16" width="10" height="18" rx="2" fill="#D4AF5A"/></svg>
        Aurum
      </div>
      <span className="sep" />
      <div className="sym">{config?.symbol ?? 'XAUUSD'}<small>{config?.brokerSymbol ?? ''}</small></div>
      <div className="tfs" role="group" aria-label="Timeframe">
        {TIMEFRAMES.map((t) => (
          <button key={t} className="tf" aria-pressed={t === tf} onClick={() => onTf(t)}>{t}</button>
        ))}
      </div>
      <span className="sep" />
      <div className="quote mono" aria-label="Live quote">
        <span><span className="lbl">BID</span>{tick ? f2(tick.bid) : '—'}</span>
        <span><span className="lbl">ASK</span>{tick ? f2(tick.ask) : '—'}</span>
        <span><span className="lbl">SPREAD</span>{tick ? `${f2(tick.spread)} (${(tick.spread / pip).toFixed(1)} pips)` : '—'}</span>
      </div>
      <div className="spacer" />
      <span className="lbl" style={{ color: 'var(--t3)', fontSize: 11 }} title="Candle times follow the broker server clock, same as MT5">Broker time</span>
      {account ? (
        <span className={`chip ${account.demo ? 'demo' : 'live'}`} title={`${account.server} · ${account.currency} · #${account.login}`}>
          {account.demo ? 'DEMO' : 'LIVE'} · {account.server}
        </span>
      ) : (
        <span className="chip info">No account</span>
      )}
      {saveError && <span className="chip err" title={saveError}>✕ Save failed</span>}
      <span className={`chip ${st.cls}`} title={status.message}><span aria-hidden="true">{st.icon}</span>{st.text}</span>
      <button className="btn stop" disabled title="Stops new AI actions. Nothing is running yet.">Stop AI actions</button>
      <button className="btn" onClick={onSettings}>Settings</button>
    </header>
  );
}
