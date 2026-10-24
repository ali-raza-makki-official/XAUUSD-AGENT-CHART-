import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, translatePatch, paneTimeframes, withLayout, withPaneTimeframe, undoNewest, redoOldest, DEFAULT_PANE_TIMEFRAMES, LAYOUT_PANES, type ChartLayout, type Drawing, type DrawingOp, type SymbolSpec, type Timeframe } from '@aurum/core';
import { useFeed } from './hooks';
import { useIndicators } from './useIndicators';
import { ChartGrid } from './components/ChartGrid';
import { LayoutBar } from './components/LayoutBar';
import { IndicatorsDialog, IndicatorsPanel } from './components/Indicators';
import { ChartSync } from './lib/chartSync';
import { useDrawings } from './useDrawings';
import { TopBar } from './components/TopBar';
import { BottomPanel } from './components/Panels';
import { ChatPanel } from './components/ChatPanel';
import { useAiChat } from './useAiChat';
import { useWhatsAppAi } from './useWhatsAppAi';
import { SettingsDialog } from './components/Settings';
import { Toolbar } from './components/Toolbar';
import { Activity, Bot, Layers, SlidersHorizontal } from 'lucide-react';
import { Inspector, InspectorEmpty } from './components/Inspector';
import { ObjectsPanel } from './components/Objects';
import type { ToolId } from './lib/tools';

type RightTab = 'chat' | 'objects' | 'inspector' | 'indicators';

export function App() {
  const { api, config, status, tick, account, log, update } = useFeed();
  const layout: ChartLayout = config?.layout ?? 'single';
  const layoutCfg = { layout, timeframe: config?.timeframe ?? 'M15', paneTimeframes: config?.paneTimeframes ?? [...DEFAULT_PANE_TIMEFRAMES] };
  const tfs = paneTimeframes(layoutCfg);
  const [activeRaw, setActive] = useState(0);
  const activePane = Math.min(activeRaw, LAYOUT_PANES[layout] - 1);
  const tf: Timeframe = tfs[activePane] ?? 'M15';
  const live = status.state === 'connected' || status.state === 'stale';
  const sync = useMemo(() => new ChartSync(), []);
  sync.scroll = (config?.syncScroll ?? false) && layout !== 'single';
  const [indDialog, setIndDialog] = useState(false);
  const [selectedInd, setSelectedInd] = useState<string | null>(null);
  const [settings, setSettings] = useState<false | 'general' | 'ai'>(false);
  const [aiPaused, setAiPaused] = useState(false);
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});

  const symbol = config?.symbol ?? 'XAUUSD';
  const { store, drawings, dispatch, canUndo, canRedo, saveError } = useDrawings(api, symbol);
  const ind = useIndicators(api, symbol);
  const undo = () => undoNewest([store, ind.store]);
  const redo = () => redoOldest([store, ind.store]);
  const [tool, setTool] = useState<ToolId>('cursor');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('chat');
  const [hiddenLayers, setHidden] = useState({ manual: false, ai: false });
  const [spec, setSpec] = useState<SymbolSpec | null>(null);
  const selected = useMemo(() => drawings.find((d) => d.id === selectedId) ?? null, [drawings, selectedId]);

  const chat = useAiChat({ api, config, store, tf, tick, status, account, spec, selectedId, paused: aiPaused });
  useWhatsAppAi({ api, config, store, tf, tick, status, account, spec, selectedId, paused: aiPaused });
  useEffect(() => { if (api && !settings) void api.aiStatus().then((s) => setHasKey(s.hasKey)); }, [api, settings]);
  const aiProvider = config?.ai.provider ?? null;
  const aiReady = !!aiProvider && !!hasKey[aiProvider];

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

  const pickTf = (t: Timeframe) => { void update(withPaneTimeframe(layoutCfg, activePane, t)); };
  const setLayout = (l: ChartLayout) => { void update(withLayout(layoutCfg, l)); };
  const addIndicator = (t: Parameters<typeof ind.add>[0]) => { const i = ind.add(t); setIndDialog(false); if (i) { setSelectedInd(i.id); setRightTab('indicators'); } };
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
      <TopBar config={config} tf={tf} onTf={pickTf} tick={tick} status={status} account={account} saveError={saveError} onSettings={() => setSettings('general')} aiPaused={aiPaused} aiRunning={chat.running} onToggleAi={() => setAiPaused((p) => !p)} />
      <Toolbar
        tool={tool} onTool={setTool}
        canUndo={canUndo || ind.store.canUndo} canRedo={canRedo || ind.store.canRedo} onUndo={undo} onRedo={redo}
        magnet={config?.magnet ?? true} onMagnet={() => void update({ magnet: !(config?.magnet ?? true) })}
        stayInTool={config?.stayInTool ?? false} onStay={() => void update({ stayInTool: !(config?.stayInTool ?? false) })}
      />
      <main className="chartwrap">
        <LayoutBar
          layout={layout} onLayout={setLayout} syncScroll={config?.syncScroll ?? false} onSync={() => void update({ syncScroll: !(config?.syncScroll ?? false) })}
          activePane={activePane} activeTf={tf} indicatorCount={ind.indicators.length} onIndicators={() => setIndDialog(true)}
        />
        <ChartGrid
          layout={layout} tfs={tfs} activePane={activePane} sync={sync}
          feed={{ api, status, brokerSymbol: config?.brokerSymbol ?? 'GOLD' }}
          onActivate={setActive} onPaneTf={(i, t) => void update(withPaneTimeframe(layoutCfg, i, t))}
          view={{
            tick, pipSize, store, drawings, hiddenLayers, tool, onTool: setTool, stayInTool: config?.stayInTool ?? false, magnet: config?.magnet ?? true,
            toolStyles: config?.toolStyles ?? {}, selectedId, onSelect: (id, open) => { select(id); if (open) setRightTab('inspector'); },
            dispatch, indicators: ind.indicators, onUndo: undo, onRedo: redo,
          }}
        />
      </main>
      <div className="rightcol">
        <div className="rtabs" role="tablist">
          <button role="tab" className="rtab" aria-selected={rightTab === 'chat'} onClick={() => setRightTab('chat')}><Bot size={15} />AI chat</button>
          <button role="tab" className="rtab" aria-selected={rightTab === 'objects'} onClick={() => setRightTab('objects')}><Layers size={15} />Objects <span className="count">{drawings.length}</span></button>
          <button role="tab" className="rtab" aria-selected={rightTab === 'inspector'} onClick={() => setRightTab('inspector')}><SlidersHorizontal size={15} />Inspector</button>
          <button role="tab" className="rtab" aria-selected={rightTab === 'indicators'} onClick={() => setRightTab('indicators')}><Activity size={15} />Indicators</button>
        </div>
        <div className="rbody">
          {rightTab === 'chat' && (
            <ChatPanel
              chat={chat} ready={aiReady} providerLabel={aiProvider ? PROVIDERS[aiProvider].label : null}
              model={aiProvider ? (config?.ai.models[aiProvider] || PROVIDERS[aiProvider].suggestedModel) : ''}
              paused={aiPaused} canDraw={!!config?.aiPermissions.drawingsEdit} onResume={() => setAiPaused(false)} onSettings={() => setSettings('ai')}
            />
          )}
          {rightTab === 'objects' && (
            <ObjectsPanel
              drawings={drawings} selectedId={selectedId} hiddenLayers={hiddenLayers}
              onHideLayer={(l) => setHidden((h) => ({ ...h, [l]: !h[l] }))}
              onSelect={select} onPatch={patch} onDelete={remove} onClear={clearAll}
            />
          )}
          {rightTab === 'indicators' && (
            <IndicatorsPanel
              indicators={ind.indicators} selectedId={selectedInd} activeTf={tf} onSelect={setSelectedInd}
              onPatch={(id, p, l) => ind.dispatch([{ op: 'update', id, patch: p }], l)}
              onDelete={(id) => { ind.dispatch([{ op: 'delete', id }], 'Remove indicator'); if (id === selectedInd) setSelectedInd(null); }}
              onAdd={() => setIndDialog(true)}
            />
          )}
          {rightTab === 'inspector' && (selected
            ? <Inspector d={selected} pipSize={pipSize} spec={spec} account={account} onPatch={(p, l) => patch(selected.id, p, l)} onDelete={() => remove(selected.id)} onDuplicate={() => duplicate(selected)} />
            : <InspectorEmpty />)}
        </div>
      </div>
      <BottomPanel log={log} aiActions={store.history().filter((h) => h.actor === 'ai')} onUndoAllAi={() => { const d = new Date(); d.setHours(0, 0, 0, 0); store.revertActor('ai', d.getTime()); }} api={api} config={config} />
      {indDialog && <IndicatorsDialog onAdd={addIndicator} onClose={() => setIndDialog(false)} />}
      {settings && api && config && <SettingsDialog api={api} config={config} onSave={update} initialTab={settings} onClose={() => setSettings(false)} />}
    </div>
  );
}
