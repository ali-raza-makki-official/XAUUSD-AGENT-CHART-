import { useState } from 'react';
import type { Timeframe } from '@aurum/core';
import { useCandles, useFeed } from './hooks';
import { TopBar } from './components/TopBar';
import { ChartView } from './components/ChartView';
import { BottomPanel, ChatPanel } from './components/Panels';
import { SettingsDialog } from './components/Settings';

export function App() {
  const { api, config, status, tick, account, log, update } = useFeed();
  const [tfOverride, setTf] = useState<Timeframe | null>(null);
  const tf: Timeframe = tfOverride ?? config?.timeframe ?? 'M15';
  const live = status.state === 'connected' || status.state === 'stale';
  const { candles, error, loading } = useCandles(tf, live);
  const [settings, setSettings] = useState(false);

  const pickTf = (t: Timeframe) => {
    setTf(t);
    void update({ timeframe: t });
  };

  return (
    <div className="app">
      <TopBar config={config} tf={tf} onTf={pickTf} tick={tick} status={status} account={account} onSettings={() => setSettings(true)} />
      <nav className="toolbar" aria-label="Drawing tools" />
      <main className="chartwrap">
        <ChartView candles={candles} tick={tick} tf={tf} />
        {!api && (
          <div className="overlay"><div className="state"><h2>Open the Aurum desktop app</h2><p>This page is not running inside Aurum, so there is no MT5 connection and no market data.</p></div></div>
        )}
        {api && !candles.length && (
          <div className="overlay">
            <div className="state">
              <h2>{live ? (loading ? 'Loading candles…' : 'No candles received') : status.state === 'starting' ? 'Connecting to MT5…' : 'MT5 is not connected'}</h2>
              {!live && status.state !== 'starting' && (
                <>
                  <p>No price data is shown until a real MT5 feed is connected.</p>
                  <ol>
                    <li>Open the MT5 terminal from Exness and log in to your demo account.</li>
                    <li>Make sure gold ({config?.brokerSymbol ?? 'GOLD'}) is in Market Watch.</li>
                    <li>If the symbol name differs, change it in Settings.</li>
                  </ol>
                  <p className="err">{status.message}</p>
                  <button className="btn primary" onClick={() => void api.reconnect()}>Retry</button>
                </>
              )}
              {error && <p className="err">{error}</p>}
            </div>
          </div>
        )}
      </main>
      <ChatPanel />
      <BottomPanel log={log} />
      {settings && api && config && <SettingsDialog api={api} config={config} onSave={update} onClose={() => setSettings(false)} />}
    </div>
  );
}
