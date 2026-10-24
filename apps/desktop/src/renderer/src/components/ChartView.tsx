import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import {
  CandlestickSeries, ColorType, CrosshairMode, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import {
  applyTick, handleAt, handlePatch, hitDistance, isShownOn, layoutDrawing, makeDrawing, translatePatch,
  type Candle, type Drawing, type DrawingOp, type DrawingStore, type Indicator, type Point, type Style, type Tick, type Timeframe,
} from '@aurum/core';
import { ChartMapper } from '../lib/mapper';
import { IndicatorLayer } from '../lib/indicatorLayer';
import type { ChartSync } from '../lib/chartSync';
import { DrawingsPrimitive, type Scene } from '../lib/primitive';
import { toolById, type ToolId } from '../lib/tools';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const toBar = (c: Candle) => ({ ...c, time: c.time as UTCTimestamp });
const HIT_PX = 7;

export interface ChartHandle { requestRedraw(): void }

interface Props {
  candles: Candle[];
  tick: Tick | null;
  tf: Timeframe;
  pipSize: number;
  store: DrawingStore;
  drawings: Drawing[];
  hiddenLayers: { manual: boolean; ai: boolean };
  tool: ToolId;
  onTool: (t: ToolId) => void;
  stayInTool: boolean;
  magnet: boolean;
  toolStyles: Record<string, Partial<Style>>;
  selectedId: string | null;
  onSelect: (id: string | null, open?: boolean) => void;
  dispatch: (ops: DrawingOp[], label: string) => unknown;
  /** Multi-chart: which pane this is, whether it receives drawing input/keys, and how to become the active pane. */
  paneId?: number;
  active?: boolean;
  onActivate?: () => void;
  /** Undo/redo across drawings and indicators; defaults to the drawing store only. */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Indicator instances (shared by all panes; filtered per pane timeframe). */
  indicators?: Indicator[];
  /** Crosshair/scroll link to the other panes. */
  sync?: ChartSync;
}

/** Index of the candle containing `time` (last candle at or before it). */
function candleAt(candles: Candle[], time: number): number {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

type Drag = { mode: 'move' | 'handle'; id: string; key?: string; start: Point; startPx: [number, number]; original: Drawing; moved: boolean };

export const ChartView = forwardRef<ChartHandle, Props>(function ChartView(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const prim = useRef<DrawingsPrimitive | null>(null);
  const mapper = useRef<ChartMapper | null>(null);
  const bidLine = useRef<IPriceLine | null>(null);
  const indLayer = useRef<IndicatorLayer | null>(null);
  const quiet = useRef({ cross: 0, range: 0 }); // ignore our own echo for a moment after applying a remote update
  const last = useRef<Candle | null>(null);
  const p = useRef(props);
  p.current = props;
  // Interaction state lives in refs: it changes on every mouse move and must not re-render React.
  const pending = useRef<Point[]>([]);
  const hover = useRef<{ pt: Point | null; id: string | null }>({ pt: null, id: null });
  const drag = useRef<Drag | null>(null);
  const preview = useRef<Drawing | null>(null);

  const redraw = () => prim.current?.requestUpdate();
  useImperativeHandle(ref, () => ({ requestRedraw: redraw }));

  const visible = () => p.current.drawings.filter((d) => isShownOn(d, p.current.tf) && !p.current.hiddenLayers[d.layer]);

  const scene = (): Scene => {
    const { selectedId, tool } = p.current;
    const items = visible().map((d) => ({
      drawing: preview.current && preview.current.id === d.id ? preview.current : d,
      selected: d.id === selectedId,
      hovered: tool === 'cursor' && d.id === hover.current.id,
    }));
    const t = toolById(tool);
    if (t.build && pending.current.length > 0) {
      const pts = [...pending.current, ...(hover.current.pt ? [hover.current.pt] : [])];
      const geo = t.build(pts);
      if (geo) {
        try {
          items.push({ drawing: makeDrawing(geo as never, { id: '__preview', style: p.current.toolStyles[geo.kind as string] }), selected: false, hovered: false });
        } catch { /* incomplete geometry while previewing */ }
      }
    }
    return { mapper: mapper.current, items, tfLabel: p.current.tf };
  };

  // --- chart + primitive lifecycle
  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--bg-panel') }, textColor: css('--t2'), fontFamily: css('--font-mono'), fontSize: 12 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css('--border') },
      timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false, rightOffset: 12 },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css('--buy'), downColor: css('--sell'), borderUpColor: css('--buy'), borderDownColor: css('--sell'),
      wickUpColor: css('--buy'), wickDownColor: css('--sell'),
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const pr = new DrawingsPrimitive(scene);
    s.attachPrimitive(pr);
    chart.current = c; series.current = s; prim.current = pr;
    mapper.current = new ChartMapper(c, s, [], p.current.tf, p.current.pipSize);
    indLayer.current = new IndicatorLayer(c);

    // Link to the other panes by time (they may have different timeframes).
    const paneId = p.current.paneId ?? 0;
    const onCross = (param: { point?: { x: number; y: number }; time?: unknown; paneIndex?: number }) => {
      if (performance.now() < quiet.current.cross) return;
      const bus = p.current.sync;
      if (!bus) return;
      if (!param.point || param.time === undefined) { bus.crosshair(paneId, null, null); return; }
      const onPrice = param.paneIndex === undefined || param.paneIndex === 0;
      bus.crosshair(paneId, param.time as number, onPrice ? s.coordinateToPrice(param.point.y) : null);
    };
    const onRange = (r: { from: number; to: number } | null) => {
      if (!r || performance.now() < quiet.current.range) return;
      const m = mapper.current;
      if (!m || !m.candles.length) return;
      p.current.sync?.range(paneId, m.logicalToTime(r.from), m.logicalToTime(r.to));
    };
    c.subscribeCrosshairMove(onCross as never);
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const unregister = p.current.sync?.register(paneId, {
      crosshair(time, price) {
        const m = mapper.current;
        if (!m) return;
        quiet.current.cross = performance.now() + 60;
        const i = time === null ? -1 : candleAt(m.candles, time);
        const k = m.candles[i];
        if (!k) { c.clearCrosshairPosition(); return; }
        c.setCrosshairPosition(price ?? k.close, k.time as UTCTimestamp, s);
      },
      range(fromTime, toTime) {
        const m = mapper.current;
        if (!m || !m.candles.length) return;
        quiet.current.range = performance.now() + 150;
        c.timeScale().setVisibleLogicalRange({ from: m.timeToLogical(fromTime), to: m.timeToLogical(toTime) } as never);
      },
    });
    return () => {
      unregister?.();
      c.unsubscribeCrosshairMove(onCross as never);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      c.remove();
      chart.current = series.current = prim.current = mapper.current = bidLine.current = indLayer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!series.current || !mapper.current) return;
    series.current.setData(props.candles.map(toBar));
    last.current = props.candles[props.candles.length - 1] ?? null;
    mapper.current.candles = props.candles.slice();
    if (props.candles.length) chart.current?.timeScale().scrollToRealTime();
    indLayer.current?.sync(props.indicators ?? [], props.tf, props.candles);
    redraw();
  }, [props.candles]);

  // Indicator instances or this pane's timeframe changed: rebuild only the series that differ.
  useEffect(() => {
    if (!mapper.current) return;
    indLayer.current?.sync(props.indicators ?? [], props.tf, mapper.current.candles);
    redraw();
  }, [props.indicators, props.tf]);

  // Another pane was activated: abandon any half-drawn shape here.
  useEffect(() => {
    if (props.active ?? true) return;
    pending.current = []; preview.current = null; drag.current = null; redraw();
  }, [props.active]);

  useEffect(() => {
    if (mapper.current) { mapper.current.tf = props.tf; mapper.current.pipSize = props.pipSize; }
    redraw();
  }, [props.tf, props.pipSize, props.drawings, props.selectedId, props.hiddenLayers, props.tool]);

  useEffect(() => {
    const t = props.tick;
    if (!t || !series.current || !last.current || !mapper.current) return;
    const next = applyTick([last.current], t, props.tf);
    const bar = next[next.length - 1]!;
    const prev = last.current;
    if (bar.time !== prev.time || bar.close !== prev.close || bar.high !== prev.high || bar.low !== prev.low) {
      series.current.update(toBar(bar));
      if (bar.time !== prev.time) mapper.current.candles.push(bar); else mapper.current.candles[mapper.current.candles.length - 1] = bar;
      last.current = bar;
      indLayer.current?.updateLast(mapper.current.candles);
    }
    if (bidLine.current) bidLine.current.applyOptions({ price: t.bid });
    else bidLine.current = series.current.createPriceLine({ price: t.bid, color: css('--t3'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'bid' });
  }, [props.tick, props.tf]);

  // --- pointer interaction
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const local = (e: MouseEvent): [number, number] => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const inPane = (x: number, y: number) => {
      const w = chart.current?.timeScale().width() ?? 0;
      const h = chart.current?.paneSize().height ?? 0;
      return x >= 0 && x <= w && y >= 0 && y <= h;
    };
    const projNow = () => mapper.current!.proj(chart.current!.timeScale().width(), chart.current!.paneSize().height);
    const setNav = (on: boolean) => chart.current?.applyOptions({ handleScroll: on, handleScale: on });

    const pick = (x: number, y: number): { d: Drawing; dist: number } | null => {
      let best: { d: Drawing; dist: number } | null = null;
      for (const d of visible()) {
        const dist = hitDistance(layoutDrawing(d, projNow()), x, y);
        if (dist <= HIT_PX && (!best || dist <= best.dist)) best = { d, dist };
      }
      return best;
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !mapper.current) return;
      const [x, y] = local(e);
      if (!inPane(x, y)) return;
      const { tool, magnet } = p.current;
      const pt = mapper.current.pointAt(x, y, magnet);

      // Only the active pane receives drawing input; the first click on another pane just makes it active.
      if (!(p.current.active ?? true)) {
        p.current.onActivate?.();
        if (tool !== 'cursor') { e.stopPropagation(); return; }
      }

      if (tool !== 'cursor') {
        e.stopPropagation();
        setNav(false);
        const def = toolById(tool);
        pending.current.push(pt);
        if (pending.current.length >= def.clicks) {
          const geo = def.build?.(pending.current);
          pending.current = [];
          if (geo) {
            const d = makeDrawing(geo as never, { style: p.current.toolStyles[geo.kind as string] });
            const r = p.current.dispatch([{ op: 'create', drawing: d }], `Draw ${def.label.toLowerCase()}`) as { ok: boolean } | undefined;
            if (r?.ok) p.current.onSelect(d.id, d.kind === 'text');
          }
          if (!p.current.stayInTool) p.current.onTool('cursor');
        }
        redraw();
        setTimeout(() => setNav(true), 0);
        return;
      }

      // cursor: handle first (selected drawing), then body
      const sel = p.current.drawings.find((d) => d.id === p.current.selectedId);
      if (sel && !sel.locked) {
        const h = handleAt(layoutDrawing(sel, projNow()), x, y);
        if (h) {
          e.stopPropagation(); setNav(false);
          drag.current = { mode: 'handle', id: sel.id, key: h.key, start: pt, startPx: [x, y], original: sel, moved: false };
          return;
        }
      }
      const hit = pick(x, y);
      if (hit) {
        e.stopPropagation(); setNav(false);
        p.current.onSelect(hit.d.id);
        if (!hit.d.locked) drag.current = { mode: 'move', id: hit.d.id, start: mapper.current.pointAt(x, y, false), startPx: [x, y], original: hit.d, moved: false };
      } else if (p.current.selectedId) {
        p.current.onSelect(null);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!mapper.current) return;
      const [x, y] = local(e);
      const { tool, magnet } = p.current;
      if (tool !== 'cursor') {
        if (!(p.current.active ?? true)) { hover.current.pt = null; el.style.cursor = ''; return; }
        hover.current.pt = inPane(x, y) ? mapper.current.pointAt(x, y, magnet) : null;
        el.style.cursor = 'crosshair';
        if (pending.current.length) redraw();
        return;
      }
      const dg = drag.current;
      if (dg) {
        if (!dg.moved && Math.hypot(x - dg.startPx[0], y - dg.startPx[1]) < 3) return;
        dg.moved = true;
        const cur = mapper.current.pointAt(x, y, dg.mode === 'handle' ? magnet : false);
        const patch = dg.mode === 'move'
          ? translatePatch(dg.original, cur.time - dg.start.time, cur.price - dg.start.price)
          : handlePatch(dg.original, dg.key!, cur.time, cur.price);
        preview.current = { ...dg.original, ...patch } as Drawing;
        redraw();
        return;
      }
      const hit = inPane(x, y) ? pick(x, y) : null;
      const sel = p.current.drawings.find((d) => d.id === p.current.selectedId);
      const onHandle = sel && !sel.locked && inPane(x, y) && handleAt(layoutDrawing(sel, projNow()), x, y);
      el.style.cursor = onHandle ? 'grab' : hit ? (hit.d.locked ? 'not-allowed' : 'move') : '';
      const id = hit?.d.id ?? null;
      if (id !== hover.current.id) { hover.current.id = id; redraw(); }
    };

    const onUp = () => {
      const dg = drag.current;
      drag.current = null;
      setNav(true);
      if (!dg) return;
      const pv = preview.current;
      preview.current = null;
      if (dg.moved && pv) {
        const { id, kind, layer, origin, ...rest } = pv as Drawing & Record<string, unknown>;
        void id; void kind; void layer; void origin;
        const patch: Record<string, unknown> = {};
        for (const k of Object.keys(rest)) {
          if (JSON.stringify(rest[k]) !== JSON.stringify((dg.original as Record<string, unknown>)[k])) patch[k] = rest[k];
        }
        if (Object.keys(patch).length) p.current.dispatch([{ op: 'update', id: dg.id, patch }], dg.mode === 'move' ? 'Move drawing' : 'Edit drawing point');
      }
      redraw();
    };

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(p.current.active ?? true)) return; // keys belong to the active pane only, so undo never runs twice
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { pending.current = []; preview.current = null; p.current.onTool('cursor'); p.current.onSelect(null); redraw(); return; }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); (p.current.onUndo ?? (() => p.current.store.undo()))(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); (p.current.onRedo ?? (() => p.current.store.redo()))(); return; }
      const sel = p.current.drawings.find((d) => d.id === p.current.selectedId);
      if (sel && (e.key === 'Delete' || e.key === 'Backspace') && !sel.locked) { p.current.dispatch([{ op: 'delete', id: sel.id }], 'Delete drawing'); p.current.onSelect(null); return; }
      if (sel && mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const copy = { ...sel, id: crypto.randomUUID(), locked: false, origin: { by: 'manual' as const, at: Date.now() }, layer: 'manual' as const };
        const shifted = { ...copy, ...translatePatch(copy as Drawing, 0, -0.5) } as Drawing;
        const r = p.current.dispatch([{ op: 'create', drawing: shifted }], 'Duplicate drawing') as { ok: boolean } | undefined;
        if (r?.ok) p.current.onSelect(shifted.id);
        return;
      }
      if (!mod && !e.altKey) {
        const t = ['cursor', 'hline', 'vline', 'ray', 'trendline', 'channel', 'zone', 'fib', 'long', 'short', 'measure', 'text']
          .map((id) => toolById(id as ToolId)).find((d) => d.key === e.key.toUpperCase());
        if (t) { pending.current = []; p.current.onTool(t.id); }
      }
    };

    el.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    el.addEventListener('dblclick', () => { if (hover.current.id) p.current.onSelect(hover.current.id, true); });
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="chart" ref={host} />;
});
