import { useEffect, useMemo, useRef, useState } from 'react';
import { translatePatch, type Drawing, type DrawingOp, type SymbolSpec, type Timeframe } from '@aurum/core';
import { useCandles, useFeed } from './hooks';
import { useDrawings } from './useDrawings';
import { TopBar } from './components/TopBar';
import { ChartView } from './components/ChartView';
import { BottomPanel, ChatPanel } from './components/Panels';
import { SettingsDialog } from './components/Settings';
import { Toolbar } from './components/Toolbar';
import { Bot, Layers, SlidersHorizontal, Unplug, LoaderCircle, Monitor } from 'lucide-react';
import { Inspector, InspectorEmpty } from './components/Inspector';
import { Button } from './components/ui';
import { ObjectsPanel } from './components/Objects';
import type { ToolId } from './lib/tools';

type RightTab = 'chat' | 'objects' | 'inspector';

export function App() {
  const { api, config, status, tick, account, log, update } = useFeed();
  const [tfOverride, setTf] = useState<Timeframe | null>(null);
  const tf: Timeframe = tfOverride ?? config?.timeframe ?? 'M15';
  const live = status.state === 'connected' || status.state === 'stale';
  const { candles, error, loading } = useCandles(tf, live);
  const [settings, setSettings] = useState(false);

  const symbol = config?.symbol ?? 'XAUUSD';
  const { store, drawings, dispatch, canUndo, canRedo, saveError } = useDrawings(api, symbol);
  const [tool, setTool] = useState<ToolId>('cursor');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('chat');
  const [hiddenLayers, setHidden] = useState({ manual: false, ai: false });
  const [spec, setSpec] = useState<SymbolSpec | null>(null);
  const selected = useMemo(() => drawings.find((d) => d.id === selectedId) ?? null, [drawings, selectedId]);

  useEffect(() => {
    if (!api || !live) return;
    api.symbolSpec().then(setSpec).catch(() => setSpec(null));
  }, [api, live, config?.brokerSymbol]);

  // If the selected drawing disappears (undo, delete), fall back to the objects list.
  const wasSelected = useRef(false);
  useEffect(() => {
    if (selectedId && !selected) { setSelectedId(null); }
    if (wasSelected.current && !selected && rightTab === 'inspector') setRightTab('objects');
    wasSelected.current = !!selected;
  }, [selected, selectedId, rightTab]);

  const pickTf = (t: Timeframe) => { setTf(t); void update({ timeframe: t }); };
  const select = (id: string | null) => { setSelectedId(id); if (id) setRightTab('inspector'); };
  const patch = (id: string, p: Record<string, unknown>, label: string) => dispatch([{ op: 'update', id, patch: p }], label);
  const remove = (id: string) => { dispatch([{ op: 'delete', id }], 'Delete drawing'); if (id === selectedId) setSelectedId(null); };
  const duplicate = (d: Drawing) => {
    const copy = { ...d, id: crypto.randomUUID(), locked: false, layer: 'manual' as const, origin: { by: 'manual' as const, at: Date.now() } } as Drawing;
    const moved = { ...copy, ...translatePatch(copy, 0, -0.5) } as Drawing;
    if ((dispatch([{ op: 'create', drawing: moved }], 'Duplicate drawing') as { ok: boolean }).ok) select(moved.id);
  };
  const clearAll = () => {
    const ops: DrawingOp[] = drawings.filter((d) => !d.locked).map((d) => ({ op: 'delete', id: d.id }));
    if (ops.length) dispatch(ops, `Delete ${ops.length} drawings`);
    setSelectedId(null);
  };

  const pipSize = config?.pipSize ?? 0.1;

  return (
    <div className="app">
      <TopBar config={config} tf={tf} onTf={pickTf} tick={tick} status={status} account={account} saveError={saveError} onSettings={() => setSettings(true)} />
      <Toolbar
        tool={tool} onTool={setTool}
        canUndo={canUndo} canRedo={canRedo} onUndo={() => store.undo()} onRedo={() => store.redo()}
        magnet={config?.magnet ?? true} onMagnet={() => void update({ magnet: !(config?.magnet ?? true) })}
        stayInTool={config?.stayInTool ?? false} onStay={() => void update({ stayInTool: !(config?.stayInTool ?? false) })}
      />
      <main className="chartwrap">
        <ChartView
          candles={candles} tick={tick} tf={tf} pipSize={pipSize}
          store={store} drawings={drawings} hiddenLayers={hiddenLayers}
          tool={tool} onTool={setTool} stayInTool={config?.stayInTool ?? false} magnet={config?.magnet ?? true}
          toolStyles={config?.toolStyles ?? {}} selectedId={selectedId} onSelect={(id, open) => { select(id); if (open) setRightTab('inspector'); }}
          dispatch={dispatch}
        />
        {!api && (
          <div className="overlay"><div className="state"><span className="state-ic"><Monitor size={20} /></span><h2>Open the Aurum desktop app</h2><p>This page is not running inside Aurum, so there is no MT5 connection and no market data.</p></div></div>
        )}
        {api && !candles.length && (
          <div className="overlay">
            <div className="state">
              <span className="state-ic">{live || status.state === 'starting' ? <LoaderCircle size={20} className="spin" /> : <Unplug size={20} />}</span>
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
                  <Button variant="primary" onClick={() => void api.reconnect()}>Retry connection</Button>
                </>
              )}
              {error && <p className="err">{error}</p>}
            </div>
          </div>
        )}
      </main>
      <div className="rightcol">
        <div className="rtabs" role="tablist">
          <button role="tab" className="rtab" aria-selected={rightTab === 'chat'} onClick={() => setRightTab('chat')}><Bot size={15} />AI chat</button>
          <button role="tab" className="rtab" aria-selected={rightTab === 'objects'} onClick={() => setRightTab('objects')}><Layers size={15} />Objects <span className="count">{drawings.length}</span></button>
          <button role="tab" className="rtab" aria-selected={rightTab === 'inspector'} onClick={() => setRightTab('inspector')}><SlidersHorizontal size={15} />Inspector</button>
        </div>
        <div className="rbody">
          {rightTab === 'chat' && <ChatPanel />}
          {rightTab === 'objects' && (
            <ObjectsPanel
              drawings={drawings} selectedId={selectedId} hiddenLayers={hiddenLayers}
              onHideLayer={(l) => setHidden((h) => ({ ...h, [l]: !h[l] }))}
              onSelect={select} onPatch={patch} onDelete={remove} onClear={clearAll}
            />
          )}
          {rightTab === 'inspector' && (selected
            ? <Inspector d={selected} pipSize={pipSize} spec={spec} account={account} onPatch={(p, l) => patch(selected.id, p, l)} onDelete={() => remove(selected.id)} onDuplicate={() => duplicate(selected)} />
            : <InspectorEmpty />)}
        </div>
      </div>
      <BottomPanel log={log} />
      {settings && api && config && <SettingsDialog api={api} config={config} onSave={update} onClose={() => setSettings(false)} />}
    </div>
  );
}
