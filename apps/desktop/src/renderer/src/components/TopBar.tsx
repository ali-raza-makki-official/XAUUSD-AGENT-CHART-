import { CircleAlert, LoaderCircle, OctagonX, Settings as Cog, ShieldCheck, TriangleAlert, Wifi, WifiOff, CircleDot, SaveOff } from 'lucide-react';
import { TIMEFRAMES, type AccountInfo, type AppConfig, type FeedStatus, type Tick, type Timeframe } from '@aurum/core';
import { Chip, IconButton, Segmented, Tip, Button } from './ui';

const f2 = (n: number) => n.toFixed(2);

function StatusChip({ status }: { status: FeedStatus }) {
  switch (status.state) {
    case 'connected': return <Chip tone="ok" icon={Wifi} title={status.message}>MT5 connected</Chip>;
    case 'stale': return <Chip tone="warn" icon={TriangleAlert} title={status.message}>Stale data</Chip>;
    case 'starting': return <span className="chip" title={status.message}><LoaderCircle size={12} className="spin" aria-hidden="true" />Connecting</span>;
    case 'disconnected': return <Chip tone="danger" icon={WifiOff} title={status.message}>Disconnected</Chip>;
    default: return <Chip tone="danger" icon={CircleAlert} title={status.message}>Error</Chip>;
  }
}

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
  const pip = config?.pipSize ?? 0.1;
  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#1a1e23"/><path d="M20 14v36M32 10v30M44 18v32" stroke="#7D8590" strokeWidth="3" strokeLinecap="round"/><rect x="15" y="24" width="10" height="16" rx="2" fill="#2A3038"/><rect x="39" y="26" width="10" height="14" rx="2" fill="#2A3038"/><rect x="27" y="16" width="10" height="18" rx="2" fill="#D4AF5A"/></svg>
        Aurum
      </div>
      <span className="sep" />
      <div className="sym"><b>{config?.symbol ?? 'XAUUSD'}</b><small>{config?.brokerSymbol ?? ''} · Gold vs US Dollar</small></div>
      <Segmented<Timeframe> label="Timeframe" size="sm" value={tf} onChange={onTf} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
      <span className="sep" />
      <div className="quote mono" aria-label="Live quote">
        <div className="q"><span className="l">BID</span><span className="v">{tick ? f2(tick.bid) : '—'}</span></div>
        <div className="q"><span className="l">ASK</span><span className="v">{tick ? f2(tick.ask) : '—'}</span></div>
        <div className="q sm"><span className="l">SPREAD</span><span className="v">{tick ? `${f2(tick.spread)} · ${(tick.spread / pip).toFixed(1)} pips` : '—'}</span></div>
      </div>
      <div className="spacer" />
      <Tip label="Candle times follow the broker server clock, like the MT5 chart"><span className="hint">Broker time</span></Tip>
      {account ? (
        account.demo
          ? <Chip tone="ai" icon={ShieldCheck} title={`${account.server} · ${account.currency} · #${account.login}`}>DEMO · {account.server}</Chip>
          : <Chip tone="gold" icon={CircleDot} title={`${account.server} · ${account.currency} · #${account.login}`}>LIVE · {account.server}</Chip>
      ) : <Chip>No account</Chip>}
      {saveError && <Chip tone="danger" icon={SaveOff} title={saveError}>Save failed</Chip>}
      <StatusChip status={status} />
      <Tip label="Stops new AI actions. Existing positions are not touched.">
        <Button variant="danger" size="sm" icon={OctagonX} disabled>Stop AI</Button>
      </Tip>
      <IconButton label="Settings" onClick={onSettings}><Cog size={16} strokeWidth={1.8} /></IconButton>
    </header>
  );
}
