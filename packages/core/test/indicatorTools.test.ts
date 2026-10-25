import { describe, expect, it } from 'vitest';
import {
  AiPermissionsSchema, DrawingStore, IndicatorStore, computeIndicator, makeIndicator, runAiTool, toolCatalog,
  type Candle, type ChartState, type Timeframe, type ToolContext, type ChartLayout,
} from '../src';

const state: ChartState = {
  symbol: 'XAUUSD', brokerSymbol: 'GOLD', timeframe: 'M15', feed: 'connected', bid: 3350, ask: 3350.2, spread: 0.2, tickTime: 1,
  account: { demo: true, currency: 'USD', balance: 10000 }, selectedDrawingId: null, pipSize: 0.1,
  layout: 'single', paneTimeframes: ['M15'], activePane: 0, syncScroll: false,
};
// Real-looking structure, generated only for tests: a deterministic zig-zag so indicators have something to chew on.
const candles = (n: number): Candle[] => Array.from({ length: n }, (_, i) => {
  const c = 3300 + i * 0.5 + Math.sin(i / 4) * 6;
  return { time: 1_700_000_000 + i * 900, open: c - 0.3, high: c + 1.5, low: c - 1.5, close: c, volume: 20 + (i % 9) };
});
let n = 0;
interface Calls { layout: [ChartLayout, Timeframe[] | undefined][]; tf: [number, Timeframe][]; sync: boolean[] }
function ctx(perms: Record<string, unknown> = {}, over: Partial<ToolContext> = {}, calls?: Calls): ToolContext {
  return {
    store: new DrawingStore(), indicators: new IndicatorStore(),
    permissions: AiPermissionsSchema.parse({ indicatorsEdit: true, chartControl: true, ...perms }),
    getState: () => state, getCandles: async (_tf, count) => candles(Math.min(count, 600)), getSpec: () => null,
    startOfToday: () => 0, newId: () => `id-${++n}-xxxxxxxxxxxx`,
    chart: calls ? {
      setLayout: (l, t) => { calls.layout.push([l, t]); },
      setPaneTimeframe: (p, t) => { calls.tf.push([p, t]); },
      setSyncScroll: (b) => { calls.sync.push(b); },
    } : undefined,
    ...over,
  };
}
const run = async (c: ToolContext, name: string, input: unknown) => runAiTool(c, name, input);
const data = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? (r.data as any) : null);

describe('indicator AI tools: permissions', () => {
  it('indicatorsEdit and chartControl default to off and hide the tools', async () => {
    const perms = AiPermissionsSchema.parse({});
    expect(perms.indicatorsEdit).toBe(false);
    expect(perms.chartControl).toBe(false);
    const names = toolCatalog(perms).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_indicators', 'get_indicator_values']));
    for (const hidden of ['add_indicator', 'update_indicator', 'remove_indicator', 'set_layout', 'set_timeframe']) expect(names).not.toContain(hidden);
    const c = ctx({ indicatorsEdit: false, chartControl: false });
    expect(await run(c, 'add_indicator', { type: 'ema', reason: 'trend filter' })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await run(c, 'set_layout', { layout: 'four' })).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('read tools need only chartRead; edit tools need their own switch', async () => {
    const readOnly = ctx({ indicatorsEdit: false, chartControl: false });
    expect((await run(readOnly, 'list_indicators', {})).ok).toBe(true);
    expect((await run(readOnly, 'get_indicator_values', { type: 'sma' })).ok).toBe(true);
    const off = ctx({ chartRead: false });
    expect(await run(off, 'list_indicators', {})).toMatchObject({ ok: false, code: 'permission_denied' });
    const names = toolCatalog(AiPermissionsSchema.parse({ indicatorsEdit: true, chartControl: true })).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['add_indicator', 'update_indicator', 'remove_indicator', 'set_layout', 'set_timeframe']));
    // drawings stay separate
    expect(names).not.toContain('create_drawing');
  });
});

describe('list_indicators / get_indicator_values', () => {
  it('lists the full catalogue with parameter ranges and the active instances', async () => {
    const c = ctx();
    await run(c, 'add_indicator', { type: 'rsi', reason: 'momentum check' });
    const d = data(await run(c, 'list_indicators', {}));
    expect(d.catalogue.map((x: any) => x.type)).toEqual(['sma', 'ema', 'wma', 'rsi', 'macd', 'bollinger', 'atr', 'stochastic', 'vwap', 'supertrend']);
    const rsi = d.catalogue.find((x: any) => x.type === 'rsi');
    expect(rsi.placement).toBe('pane');
    expect(rsi.params[0]).toMatchObject({ key: 'period', default: 14, min: 1, max: 500 });
    expect(d.catalogue.find((x: any) => x.type === 'vwap').usesTickVolume).toBe(true);
    expect(d.active).toHaveLength(1);
    expect(d.active[0]).toMatchObject({ type: 'rsi', layer: 'ai' });
  });

  it('returns values computed by code from real candles (matches the maths exactly)', async () => {
    const calls: unknown[] = [];
    const c = ctx({}, { getCandles: async (tf, count) => { calls.push([tf, count]); return candles(300); } });
    const r = await run(c, 'get_indicator_values', { type: 'ema', params: { period: 10 }, timeframe: 'H1', count: 3 });
    const d = data(r);
    expect(calls).toEqual([['H1', 1500]]); // same history depth the chart loads
    const all = candles(300);
    const expected = computeIndicator('ema', all, { period: 10 }).value!;
    expect(d.rows).toHaveLength(3);
    expect(d.rows.at(-1)[0]).toBe(all.at(-1)!.time);
    expect(d.rows.at(-1)[1]).toBe(expected.at(-1));
    expect(d.columns).toEqual(['time', 'value']);
    expect(d.lastCandleIsForming).toBe(true);
  });

  it('uses an instance by id, reports multi-output columns and null for undefined values', async () => {
    const c = ctx({}, { getCandles: async () => candles(40) });
    const added = data(await run(c, 'add_indicator', { type: 'macd', reason: 'trend' }));
    const d = data(await run(c, 'get_indicator_values', { id: added.id, count: 40 }));
    expect(d.columns).toEqual(['time', 'macd', 'signal', 'histogram']);
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.rows.some((row: (number | null)[]) => row[2] === null)).toBe(true); // signal not defined yet at 40 candles
    expect(d.warning).toBeUndefined();
  });

  it('warns when there are fewer candles than the indicator needs; never invents values', async () => {
    const c = ctx({}, { getCandles: async () => candles(5) });
    const d = data(await run(c, 'get_indicator_values', { type: 'sma', params: { period: 50 } }));
    expect(d.rows).toEqual([]);
    expect(d.warning).toMatch(/needed/);
  });

  it('labels VWAP as tick-volume based', async () => {
    const d = data(await run(ctx(), 'get_indicator_values', { type: 'vwap' }));
    expect(d.note).toMatch(/tick volume/i);
    expect(d.name).toMatch(/tick volume/i);
  });

  it('rejects bad input and surfaces feed errors', async () => {
    const c = ctx();
    expect(await run(c, 'get_indicator_values', {})).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'get_indicator_values', { id: 'nope' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'get_indicator_values', { type: 'sma', params: { period: -3 } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'get_indicator_values', { type: 'sma', params: { bogus: 1 } })).toMatchObject({ ok: false, code: 'invalid_input' });
    const down = ctx({}, { getCandles: async () => { throw new Error('MT5 is not connected'); } });
    expect(await run(down, 'get_indicator_values', { type: 'sma' })).toMatchObject({ ok: false, code: 'unavailable', error: 'MT5 is not connected' });
    const empty = ctx({}, { getCandles: async () => [] });
    expect(await run(empty, 'get_indicator_values', { type: 'sma' })).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('add / update / remove indicator', () => {
  it('adds an AI-marked instance with custom style, as one undoable step', async () => {
    const c = ctx();
    const r = await run(c, 'add_indicator', { type: 'macd', params: { fast: 8, slow: 21 }, color: '#112233', width: 3, lineStyle: 'dashed', outputColors: { signal: '#ff8800' }, timeframes: ['H1', 'H4'], reason: 'Faster MACD for entries' });
    expect(r.ok).toBe(true);
    const ind = c.indicators!.list()[0]!;
    expect(ind.origin).toMatchObject({ by: 'ai', reason: 'Faster MACD for entries' });
    expect(ind.params).toMatchObject({ fast: 8, slow: 21, signal: 9 });
    expect(ind.style).toMatchObject({ color: '#112233', width: 3, lineStyle: 'dashed' });
    expect(ind.style.outputs.signal).toEqual({ color: '#ff8800' });
    expect(ind.timeframes).toEqual(['H1', 'H4']);
    c.indicators!.undo();
    expect(c.indicators!.list()).toHaveLength(0);
  });

  it('rejects out-of-range parameters, unknown outputs and unknown types', async () => {
    const c = ctx();
    expect(await run(c, 'add_indicator', { type: 'sma', params: { period: 100000 }, reason: 'too long' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'add_indicator', { type: 'macd', params: { fast: 30, slow: 10 }, reason: 'wrong order' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'add_indicator', { type: 'rsi', outputColors: { nope: '#000000' }, reason: 'bad output' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'add_indicator', { type: 'ichimoku', reason: 'not supported' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'add_indicator', { type: 'sma', color: 'red', reason: 'bad colour' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(c.indicators!.list()).toHaveLength(0);
  });

  it('updates params, style and visibility; merges rather than replaces', async () => {
    const c = ctx();
    const id = data(await run(c, 'add_indicator', { type: 'bollinger', reason: 'volatility bands' })).id;
    const r = await run(c, 'update_indicator', { updates: [{ id, patch: { params: { period: 30 }, style: { outputs: { upper: { color: '#ff0000' } } }, visible: false }, reason: 'Wider lookback' }] });
    expect(r.ok).toBe(true);
    const ind = c.indicators!.get(id)!;
    expect(ind.params).toMatchObject({ period: 30, mult: 2 });
    expect(ind.visible).toBe(false);
    expect(ind.style.outputs.upper).toEqual({ color: '#ff0000' });
    expect(await run(c, 'update_indicator', { updates: [{ id, patch: { type: 'sma' }, reason: 'swap type' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'update_indicator', { updates: [{ id, patch: { locked: false }, reason: 'unlock' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'update_indicator', { updates: [{ id, patch: { params: { period: 0 } }, reason: 'bad' }] })).toMatchObject({ ok: false, code: 'rejected' });
    expect(await run(c, 'update_indicator', { updates: [{ id: 'missing', patch: { visible: true }, reason: 'nope' }] })).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('cannot touch locked or manual-locked indicators; can edit unlocked manual ones', async () => {
    const c = ctx();
    const mine = makeIndicator('ema', { id: 'manual-ind-1' });
    c.indicators!.dispatch({ commandId: 'seed-ind-0001', actor: 'manual', label: 's', ops: [{ op: 'create', indicator: mine }] });
    expect(await run(c, 'update_indicator', { updates: [{ id: 'manual-ind-1', patch: { params: { period: 50 } }, reason: 'tune' }] })).toMatchObject({ ok: true });
    expect(c.indicators!.get('manual-ind-1')!.origin.by).toBe('manual');
    c.indicators!.dispatch({ commandId: 'seed-ind-0002', actor: 'manual', label: 'l', ops: [{ op: 'update', id: 'manual-ind-1', patch: { locked: true } }] });
    expect(await run(c, 'update_indicator', { updates: [{ id: 'manual-ind-1', patch: { visible: false }, reason: 'hide' }] })).toMatchObject({ ok: false, code: 'rejected' });
    expect(await run(c, 'remove_indicator', { ids: ['manual-ind-1'], reason: 'clean up' })).toMatchObject({ ok: false, code: 'rejected' });
    expect(c.indicators!.get('manual-ind-1')).toBeDefined();
  });

  it('removes in one undoable batch', async () => {
    const c = ctx();
    const a = data(await run(c, 'add_indicator', { type: 'sma', reason: 'first one' })).id;
    const b = data(await run(c, 'add_indicator', { type: 'ema', reason: 'second one' })).id;
    expect((await run(c, 'remove_indicator', { ids: [a, b], reason: 'declutter' })).ok).toBe(true);
    expect(c.indicators!.list()).toHaveLength(0);
    c.indicators!.undo();
    expect(c.indicators!.list()).toHaveLength(2);
    expect(await run(c, 'remove_indicator', { ids: [], reason: 'none' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('reports unavailable without an indicator store', async () => {
    const c = ctx({}, { indicators: undefined });
    expect(await run(c, 'add_indicator', { type: 'sma', reason: 'x1x' })).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('set_layout / set_timeframe', () => {
  it('switches layout through the same control the UI uses', async () => {
    const calls: Calls = { layout: [], tf: [], sync: [] };
    const c = ctx({}, {}, calls);
    const r = await run(c, 'set_layout', { layout: 'four', paneTimeframes: ['H4', 'H1', 'M15', 'M5'], syncScroll: true });
    expect(r).toMatchObject({ ok: true, data: { layout: 'four', panes: 4, syncScroll: true } });
    expect(calls.layout).toEqual([['four', ['H4', 'H1', 'M15', 'M5']]]);
    expect(calls.sync).toEqual([true]);
  });

  it('validates layout and timeframe count', async () => {
    const calls: Calls = { layout: [], tf: [], sync: [] };
    const c = ctx({}, {}, calls);
    expect(await run(c, 'set_layout', { layout: 'six' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'set_layout', { layout: 'two', paneTimeframes: ['H1', 'M5', 'M1'] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'set_layout', { layout: 'single', paneTimeframes: ['W5'] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls.layout).toHaveLength(0);
  });

  it('sets the active pane timeframe by default and an explicit pane when given', async () => {
    const calls: Calls = { layout: [], tf: [], sync: [] };
    const four = { ...state, layout: 'four' as const, paneTimeframes: ['H4', 'H1', 'M15', 'M5'] as Timeframe[], activePane: 2 };
    const c = ctx({}, { getState: () => four }, calls);
    expect((await run(c, 'set_timeframe', { timeframe: 'M30' })).ok).toBe(true);
    expect((await run(c, 'set_timeframe', { timeframe: 'D1', pane: 0 })).ok).toBe(true);
    expect(calls.tf).toEqual([[2, 'M30'], [0, 'D1']]);
  });

  it('refuses a pane that does not exist in the current layout', async () => {
    const calls: Calls = { layout: [], tf: [], sync: [] };
    const c = ctx({}, {}, calls); // single layout
    expect(await run(c, 'set_timeframe', { timeframe: 'H1', pane: 1 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'set_timeframe', { timeframe: 'H5' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls.tf).toHaveLength(0);
  });

  it('is unavailable when the app gives no layout control', async () => {
    expect(await run(ctx(), 'set_layout', { layout: 'two' })).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
