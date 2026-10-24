import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema, DrawingStore, IndicatorSchema, IndicatorStore, indicatorTitle, isIndicatorShownOn, makeDrawing, makeIndicator, outputStyle,
  redoOldest, undoNewest, withLayout, withPaneTimeframe, paneTimeframe, paneTimeframes, candleIndexAt, mapLogicalRange, DEFAULT_PANE_TIMEFRAMES,
  type LayoutConfig,
} from '../src';

let n = 0;
const mk = (type: Parameters<typeof makeIndicator>[0], o: Parameters<typeof makeIndicator>[1] = {}) => makeIndicator(type, { id: `ind-${++n}`, ...o });
const create = (s: IndicatorStore, i = mk('ema'), actor: 'manual' | 'ai' = 'manual', commandId = `cmd-create-${++n}`) =>
  s.dispatch({ commandId, actor, label: 'add', ops: [{ op: 'create', indicator: actor === 'ai' ? { ...i, origin: { ...i.origin, by: 'ai' } } : i }] });

describe('makeIndicator / schema', () => {
  it('fills registry defaults and a sensible style', () => {
    const i = mk('macd');
    expect(i.params).toMatchObject({ fast: 12, slow: 26, signal: 9, source: 'close' });
    expect(i.visible).toBe(true);
    expect(i.timeframes).toBe('all');
    expect(i.style.width).toBe(2);
    expect(indicatorTitle(i)).toBe('MACD 12/26/9');
    expect(indicatorTitle({ ...i, label: 'My MACD' })).toBe('My MACD');
  });

  it('rejects invalid params and unknown outputs', () => {
    expect(() => mk('sma', { params: { period: 0 } })).toThrow();
    expect(IndicatorSchema.safeParse({ ...mk('rsi'), style: { ...mk('rsi').style, outputs: { nope: { color: '#112233' } } } }).success).toBe(false);
    expect(IndicatorSchema.safeParse({ ...mk('rsi'), style: { ...mk('rsi').style, color: 'red' } }).success).toBe(false);
  });

  it('resolves per-output styles: overrides win, multi-output keeps registry colours', () => {
    const m = mk('macd', { style: { outputs: { signal: { color: '#123456', width: 4 } } } });
    expect(outputStyle(m, 'signal')).toMatchObject({ color: '#123456', width: 4 });
    expect(outputStyle(m, 'macd').color).toBe('#7fa8f5');
    expect(outputStyle(m, 'histogram').negColor).toBe('#f0616d');
    const e = mk('ema', { style: { color: '#ff0000' } });
    expect(outputStyle(e, 'value').color).toBe('#ff0000');
  });

  it('visibility respects the per-timeframe list', () => {
    const i = mk('ema', { timeframes: ['H1', 'H4'] });
    expect(isIndicatorShownOn(i, 'H1')).toBe(true);
    expect(isIndicatorShownOn(i, 'M5')).toBe(false);
    expect(isIndicatorShownOn({ ...i, visible: false }, 'H1')).toBe(false);
  });
});

describe('IndicatorStore', () => {
  it('creates, updates (params + style merge), deletes and undoes/redoes', () => {
    const s = new IndicatorStore();
    const i = mk('bollinger');
    expect(create(s, i)).toMatchObject({ ok: true, duplicate: false });
    expect(s.list()).toHaveLength(1);

    const r = s.dispatch({ commandId: 'cmd-upd-0001', actor: 'manual', label: 'edit', ops: [{ op: 'update', id: i.id, patch: { params: { period: 30 }, style: { outputs: { upper: { color: '#ff0000' } } } } }] });
    expect(r.ok).toBe(true);
    const cur = s.get(i.id)!;
    expect(cur.params).toMatchObject({ period: 30, mult: 2 }); // untouched params survive the merge
    expect(cur.style.outputs.upper).toEqual({ color: '#ff0000' });

    s.dispatch({ commandId: 'cmd-upd-0002', actor: 'manual', label: 'edit2', ops: [{ op: 'update', id: i.id, patch: { style: { outputs: { upper: { width: 3 } } } } }] });
    expect(s.get(i.id)!.style.outputs.upper).toEqual({ color: '#ff0000', width: 3 });

    s.undo();
    expect(s.get(i.id)!.style.outputs.upper).toEqual({ color: '#ff0000' });
    s.undo();
    expect(s.get(i.id)!.params.period).toBe(20);
    s.redo();
    expect(s.get(i.id)!.params.period).toBe(30);

    s.dispatch({ commandId: 'cmd-del-0001', actor: 'manual', label: 'del', ops: [{ op: 'delete', id: i.id }] });
    expect(s.list()).toHaveLength(0);
    s.undo();
    expect(s.get(i.id)).toBeDefined();
  });

  it('is idempotent per commandId', () => {
    const s = new IndicatorStore();
    const i = mk('sma');
    create(s, i, 'manual', 'same-command-id');
    const again = create(s, mk('sma'), 'manual', 'same-command-id');
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(s.list()).toHaveLength(1);
  });

  it('rejects invalid updates atomically (batch is all-or-nothing)', () => {
    const s = new IndicatorStore();
    const a = mk('sma'); const b = mk('ema');
    create(s, a); create(s, b);
    const r = s.dispatch({ commandId: 'cmd-bad-0001', actor: 'manual', label: 'x', ops: [
      { op: 'update', id: a.id, patch: { params: { period: 50 } } },
      { op: 'update', id: b.id, patch: { params: { period: 9999 } } },
    ] });
    expect(r.ok).toBe(false);
    expect(s.get(a.id)!.params.period).toBe(20);
    expect(s.dispatch({ commandId: 'cmd-bad-0002', actor: 'manual', label: 'x', ops: [{ op: 'update', id: a.id, patch: { type: 'rsi' } }] })).toMatchObject({ ok: false });
    expect(s.dispatch({ commandId: 'cmd-bad-0003', actor: 'manual', label: 'x', ops: [{ op: 'update', id: 'missing', patch: { visible: false } }] })).toMatchObject({ ok: false });
    expect(s.dispatch({ commandId: 'cmd-bad-0004', actor: 'manual', label: 'x', ops: [{ op: 'update', id: a.id, patch: { style: { outputs: { nope: { color: '#000000' } } } } }] })).toMatchObject({ ok: false });
  });

  it('lock: the AI cannot change, delete, lock or unlock; the user can', () => {
    const s = new IndicatorStore();
    const i = mk('ema');
    create(s, i);
    s.dispatch({ commandId: 'cmd-lock-0001', actor: 'manual', label: 'lock', ops: [{ op: 'update', id: i.id, patch: { locked: true } }] });
    expect(s.dispatch({ commandId: 'cmd-ai-00001', actor: 'ai', label: 'x', ops: [{ op: 'update', id: i.id, patch: { visible: false } }] })).toMatchObject({ ok: false });
    expect(s.dispatch({ commandId: 'cmd-ai-00002', actor: 'ai', label: 'x', ops: [{ op: 'delete', id: i.id }] })).toMatchObject({ ok: false });
    expect(s.dispatch({ commandId: 'cmd-ai-00003', actor: 'ai', label: 'x', ops: [{ op: 'update', id: i.id, patch: { locked: false } }] })).toMatchObject({ ok: false });
    expect(s.dispatch({ commandId: 'cmd-man-0001', actor: 'manual', label: 'x', ops: [{ op: 'update', id: i.id, patch: { visible: false } }] })).toMatchObject({ ok: true });
  });

  it('AI-created indicators must be marked as AI; manual ones cannot be passed off as AI-free', () => {
    const s = new IndicatorStore();
    const asManual = mk('ema');
    expect(s.dispatch({ commandId: 'cmd-ai-10001', actor: 'ai', label: 'x', ops: [{ op: 'create', indicator: asManual }] })).toMatchObject({ ok: false });
  });

  it('emits events and keeps insertion order (pane order)', () => {
    const s = new IndicatorStore();
    const seen: string[] = [];
    s.subscribe((e) => seen.push(e.type === 'changes' ? e.direction : e.type));
    const a = mk('rsi'); const b = mk('macd');
    create(s, a); create(s, b);
    s.undo(); s.redo();
    expect(seen).toEqual(['do', 'do', 'undo', 'redo']);
    expect(s.list().map((x) => x.id)).toEqual([a.id, b.id]);
    s.load([b], ['x-command-1']);
    expect(s.list()).toHaveLength(1);
    expect(s.canUndo).toBe(false);
  });

  it('one Ctrl+Z across drawings and indicators undoes the newest action first', () => {
    let t = 1000;
    const ds = new DrawingStore(() => ++t);
    const is = new IndicatorStore(() => ++t);
    ds.dispatch({ commandId: 'draw-0001', actor: 'manual', label: 'd', ops: [{ op: 'create', drawing: makeDrawing({ kind: 'hline', price: 3340 }, { id: 'd1' }) }] });
    create(is, mk('ema'));
    ds.dispatch({ commandId: 'draw-0002', actor: 'manual', label: 'd2', ops: [{ op: 'create', drawing: makeDrawing({ kind: 'hline', price: 3350 }, { id: 'd2' }) }] });
    expect(undoNewest([ds, is])).toBe(ds); // d2
    expect(undoNewest([ds, is])).toBe(is); // the indicator
    expect(undoNewest([ds, is])).toBe(ds); // d1
    expect(undoNewest([ds, is])).toBeNull();
    expect(redoOldest([ds, is])).toBe(ds); // d1 first
    expect(redoOldest([ds, is])).toBe(is);
    expect(redoOldest([ds, is])).toBe(ds);
    expect(ds.list()).toHaveLength(2);
    expect(is.list()).toHaveLength(1);
  });
});

describe('layout config', () => {
  const base = (over: Partial<LayoutConfig> = {}): LayoutConfig => ({ layout: 'single', timeframe: 'M15', paneTimeframes: [...DEFAULT_PANE_TIMEFRAMES], ...over });

  it('defaults: single layout, H4/H1/M15/M5 for four panes, sync scroll off', () => {
    const c = AppConfigSchema.parse({});
    expect(c.layout).toBe('single');
    expect(c.paneTimeframes).toEqual(['H4', 'H1', 'M15', 'M5']);
    expect(c.syncScroll).toBe(false);
    expect(c.timeframe).toBe('M15');
  });

  it('old configs without layout fields still parse (backwards compatible)', () => {
    expect(AppConfigSchema.parse({ symbol: 'XAUUSD', timeframe: 'H1' }).layout).toBe('single');
    expect(AppConfigSchema.safeParse({ paneTimeframes: ['H1'] }).success).toBe(false);
    expect(AppConfigSchema.safeParse({ layout: 'five' }).success).toBe(false);
  });

  it('pane timeframes: single uses the classic timeframe, multi uses the per-pane list', () => {
    expect(paneTimeframes(base())).toEqual(['M15']);
    expect(paneTimeframes(base({ layout: 'two' }))).toEqual(['H4', 'H1']);
    expect(paneTimeframes(base({ layout: 'four' }))).toEqual(['H4', 'H1', 'M15', 'M5']);
    expect(paneTimeframe(base({ layout: 'four' }), 9)).toBe('H4'); // out of range falls back safely
  });

  it('setting a pane timeframe patches the right field and clamps the pane index', () => {
    expect(withPaneTimeframe(base(), 0, 'H1')).toEqual({ timeframe: 'H1' });
    expect(withPaneTimeframe(base(), 3, 'H1')).toEqual({ timeframe: 'H1' });
    expect(withPaneTimeframe(base({ layout: 'four' }), 2, 'M30')).toEqual({ paneTimeframes: ['H4', 'H1', 'M30', 'M5'] });
    expect(withPaneTimeframe(base({ layout: 'two' }), 7, 'D1')).toEqual({ paneTimeframes: ['H4', 'D1', 'M15', 'M5'] });
  });

  it('switching layout keeps the view stable', () => {
    expect(withLayout(base(), 'four')).toEqual({ layout: 'four' });
    expect(withLayout(base({ layout: 'four', paneTimeframes: ['D1', 'H1', 'M15', 'M5'] }), 'single')).toEqual({ layout: 'single', timeframe: 'D1' });
    expect(withLayout(base(), 'two', ['H4', 'M5'])).toEqual({ layout: 'two', paneTimeframes: ['H4', 'M5', 'M15', 'M5'] });
    expect(withLayout(base({ layout: 'two' }), 'single', ['H1'])).toEqual({ layout: 'single', timeframe: 'H1' });
  });

  it('candleIndexAt finds the containing candle by time', () => {
    const t = [0, 900, 1800, 2700];
    expect(candleIndexAt(t, -1)).toBe(-1);
    expect(candleIndexAt(t, 0)).toBe(0);
    expect(candleIndexAt(t, 1000)).toBe(1);
    expect(candleIndexAt(t, 99999)).toBe(3);
    expect(candleIndexAt([], 5)).toBe(-1);
  });

  it('mapLogicalRange converts a visible range across timeframes by time', () => {
    // pane A: 1 bar = 3600s from t=0; pane B: 1 bar = 900s from t=0
    const aTime = (l: number) => l * 3600;
    const bLogical = (t: number) => t / 900;
    expect(mapLogicalRange({ from: 2, to: 5.5 }, aTime, bLogical)).toEqual({ from: 8, to: 22 });
  });
});
