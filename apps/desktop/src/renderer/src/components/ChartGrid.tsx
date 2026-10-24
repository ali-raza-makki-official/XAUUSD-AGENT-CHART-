import type { ComponentProps } from 'react';
import { LoaderCircle, Monitor, Unplug } from 'lucide-react';
import { TIMEFRAMES, type ChartLayout, type FeedStatus, type Timeframe } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { useCandles } from '../hooks';
import type { ChartSync } from '../lib/chartSync';
import { ChartView } from './ChartView';
import { Button, Segmented } from './ui';

type ViewProps = Omit<ComponentProps<typeof ChartView>, 'candles' | 'tf' | 'paneId' | 'active' | 'onActivate' | 'sync'>;

interface Feed {
  api: AurumApi | undefined;
  status: FeedStatus;
  brokerSymbol: string;
}

interface PaneProps {
  paneId: number;
  tf: Timeframe;
  multi: boolean;
  active: boolean;
  feed: Feed;
  view: ViewProps;
  sync: ChartSync;
  onActivate: () => void;
  onTf: (tf: Timeframe) => void;
}

/** One chart pane: its own timeframe and candle history, the same symbol and feed as every other pane. */
function ChartPane({ paneId, tf, multi, active, feed, view, sync, onActivate, onTf }: PaneProps) {
  const { api, status, brokerSymbol } = feed;
  const live = status.state === 'connected' || status.state === 'stale';
  const { candles, error, loading } = useCandles(tf, live);
  const compact = multi && paneId > 0;
  return (
    <section className={`pane ${multi ? 'multi' : ''} ${multi && active ? 'active' : ''}`} aria-label={multi ? `Chart ${paneId + 1}, ${tf}${active ? ', active' : ''}` : 'Chart'} data-pane={paneId} data-tf={tf} data-active={active}>
      <ChartView {...view} candles={candles} tf={tf} paneId={paneId} active={active} onActivate={onActivate} sync={sync} />
      {multi && (
        <div className="pane-head">
          <Segmented<Timeframe> label={`Timeframe of chart ${paneId + 1}`} size="sm" value={tf} onChange={(t) => { onActivate(); onTf(t); }} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
        </div>
      )}
      {!api && (
        <div className="overlay"><div className="state"><span className="state-ic"><Monitor size={20} /></span><h2>{compact ? 'No MT5 connection' : 'Open the Aurum desktop app'}</h2>{!compact && <p>This page is not running inside Aurum, so there is no MT5 connection and no market data.</p>}</div></div>
      )}
      {api && !candles.length && (
        <div className="overlay">
          <div className="state">
            <span className="state-ic">{live || status.state === 'starting' ? <LoaderCircle size={20} className="spin" /> : <Unplug size={20} />}</span>
            <h2>{live ? (loading ? 'Loading candles…' : 'No candles received') : status.state === 'starting' ? 'Connecting to MT5…' : 'MT5 is not connected'}</h2>
            {!live && status.state !== 'starting' && !compact && (
              <>
                <p>No price data is shown until a real MT5 feed is connected.</p>
                <ol>
                  <li>Open the MT5 terminal from Exness and log in to your demo account.</li>
                  <li>Make sure gold ({brokerSymbol}) is in Market Watch.</li>
                  <li>If the symbol name differs, change it in Settings.</li>
                </ol>
                <p className="err">{status.message}</p>
                <Button variant="primary" onClick={() => void api.reconnect()}>Retry connection</Button>
              </>
            )}
            {error && !compact && <p className="err">{error}</p>}
          </div>
        </div>
      )}
    </section>
  );
}

interface GridProps {
  layout: ChartLayout;
  tfs: Timeframe[];
  activePane: number;
  feed: Feed;
  view: ViewProps;
  sync: ChartSync;
  onActivate: (i: number) => void;
  onPaneTf: (i: number, tf: Timeframe) => void;
}

export function ChartGrid({ layout, tfs, activePane, feed, view, sync, onActivate, onPaneTf }: GridProps) {
  return (
    <div className={`chartgrid layout-${layout}`}>
      {tfs.map((tf, i) => (
        <ChartPane
          key={i} paneId={i} tf={tf} multi={tfs.length > 1} active={i === activePane}
          feed={feed} view={view} sync={sync} onActivate={() => onActivate(i)} onTf={(t) => onPaneTf(i, t)}
        />
      ))}
    </div>
  );
}
