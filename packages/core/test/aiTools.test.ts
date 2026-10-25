import { describe, expect, it } from 'vitest';
import { AiPermissionsSchema, DrawingStore, makeDrawing, runAiTool, toolCatalog, type ChartState, type ToolContext } from '../src';

const state: ChartState = { symbol: 'XAUUSD', brokerSymbol: 'GOLD', timeframe: 'M15', feed: 'connected', bid: 3350, ask: 3350.2, spread: 0.2, tickTime: 1, account: { demo: true, currency: 'USD', balance: 10000 }, selectedDrawingId: null, pipSize: 0.1 };
const spec = { contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 };
let n = 0;
function ctx(over: Partial<ToolContext> = {}, perms = {}): ToolContext {
  return {
    store: new DrawingStore(), permissions: AiPermissionsSchema.parse({ drawingsEdit: true, ...perms }),
    getState: () => state, getCandles: async () => [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }], getSpec: () => spec,
    startOfToday: () => 0, newId: () => `id-${++n}-xxxxxxxxxxxx`, ...over,
  };
}
const run = async (c: ToolContext, name: string, input: unknown) => runAiTool(c, name, input);

describe('AI tools', () => {
  it('denies edit tools by default and hides them from the catalog', async () => {
    const c = ctx({}, { drawingsEdit: false });
    const r = await run(c, 'create_drawing', { items: [{ kind: 'hline', price: 3340, reason: 'support' }] });
    expect(r).toMatchObject({ ok: false, code: 'permission_denied' });
    const names = toolCatalog(c.permissions).map((t) => t.name);
    expect(names).toContain('get_candles');
    expect(names).not.toContain('create_drawing');
  });

  it('creates a batch on the AI layer with the reason and one undo step', async () => {
    const c = ctx();
    const r = await run(c, 'create_drawing', { items: [
      { kind: 'hline', price: 3340, label: 'S1', reason: 'Swing low rejected twice' },
      { kind: 'zone', a: { time: '2026-10-23T10:00:00', price: 3345 }, b: { time: 1_790_000_000, price: 3338 }, zoneType: 'demand', reason: 'Demand base' },
    ] });
    expect(r.ok).toBe(true);
    const all = c.store.list();
    expect(all).toHaveLength(2);
    expect(all.every((d) => d.layer === 'ai' && d.origin.reason)).toBe(true);
    c.store.undo();
    expect(c.store.list()).toHaveLength(0);
  });

  it('rejects absurd prices (likely hallucination) and wrong-sided positions', async () => {
    const c = ctx();
    expect(await run(c, 'create_drawing', { items: [{ kind: 'hline', price: 33.5, reason: 'typo' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    const r = await run(c, 'create_drawing', { items: [{ kind: 'position', side: 'buy', entryTime: 1, entry: 3350, stopLoss: 3360, takeProfits: [{ price: 3370, closePct: 100 }], reason: 'plan' }] });
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(c.store.list()).toHaveLength(0);
  });

  it('cannot edit or delete locked drawings, or touch manual ones that are locked', async () => {
    const c = ctx();
    const m = makeDrawing({ kind: 'hline', price: 3340 }, { id: 'manual-1', actor: 'manual' });
    c.store.dispatch({ commandId: 'seed-0001', actor: 'manual', label: 's', ops: [{ op: 'create', drawing: m }] });
    c.store.dispatch({ commandId: 'seed-0002', actor: 'manual', label: 'l', ops: [{ op: 'update', id: 'manual-1', patch: { locked: true } }] });
    expect(await run(c, 'update_drawing', { updates: [{ id: 'manual-1', patch: { price: 3345 }, reason: 'move' }] })).toMatchObject({ ok: false, code: 'rejected' });
    expect(await run(c, 'delete_drawing', { ids: ['manual-1'], reason: 'clean up' })).toMatchObject({ ok: false });
  });

  it('can edit an unlocked manual drawing as one undoable batch', async () => {
    const c = ctx();
    c.store.dispatch({ commandId: 'seed-0003', actor: 'manual', label: 's', ops: [{ op: 'create', drawing: makeDrawing({ kind: 'hline', price: 3340 }, { id: 'manual-2' }) }] });
    const r = await run(c, 'update_drawing', { updates: [{ id: 'manual-2', patch: { price: 3342, label: 'R1' }, reason: 'Aligned with wick highs' }] });
    expect(r.ok).toBe(true);
    expect((c.store.get('manual-2') as { price: number }).price).toBe(3342);
    expect(c.store.get('manual-2')?.layer).toBe('manual');
  });

  it('rejects unknown fields and bad input', async () => {
    const c = ctx();
    expect(await run(c, 'update_drawing', { updates: [{ id: 'x', patch: { locked: false }, reason: 'try to unlock' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'create_drawing', { items: [] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(c, 'nope', {})).toMatchObject({ ok: false });
  });

  it('calculates risk/reward in code from real balance and spec', async () => {
    const r = await run(ctx(), 'calculate_risk_reward', { side: 'buy', entry: 3350, stopLoss: 3343, takeProfits: [3364], riskPct: 0.5 });
    expect(r.ok && (r.data as any).sizing.lots).toBe(0.07);
    expect(r.ok && (r.data as any).targets[0].rewardRisk).toBe(2);
    expect(r.ok && (r.data as any).slPips).toBeCloseTo(70);
  });

  it('undo_action only reverts AI work', async () => {
    const c = ctx();
    await run(c, 'create_drawing', { items: [{ kind: 'hline', price: 3340, reason: 'level' }] });
    c.store.dispatch({ commandId: 'manual-001', actor: 'manual', label: 'm', ops: [{ op: 'create', drawing: makeDrawing({ kind: 'hline', price: 3330 }, { id: 'mine' }) }] });
    expect(await run(c, 'undo_action', { scope: 'last' })).toMatchObject({ ok: false });
    const all = await run(c, 'undo_action', { scope: 'all_ai_today' });
    expect(all.ok && (all.data as any).reverted).toBe(1);
    expect(c.store.list().map((d) => d.id)).toEqual(['mine']);
  });

  it('catalog exposes JSON schemas for the model', () => {
    const cat = toolCatalog(AiPermissionsSchema.parse({ drawingsEdit: true }));
    const create = cat.find((t) => t.name === 'create_drawing')!;
    expect(JSON.stringify(create.inputSchema)).toContain('hline');
  });
});

describe('dead zones are not drawn live', () => {
  it('rejects an extended zone that was touched 4 times, accepts it when it ends where it died', async () => {
    const away = (t: number) => ({ time: t, open: 20, high: 21, low: 17, close: 20, volume: 0 });
    const touch = (t: number) => ({ time: t, open: 20, high: 20, low: 15.5, close: 16.5, volume: 0 });
    const candles = [away(100), touch(200), away(300), touch(400), away(500), touch(600), away(700), touch(800), away(900)];
    const { runAiTool, AiPermissionsSchema, DrawingStore } = await import('../src');
    const store = new DrawingStore();
    const ctx = {
      store, permissions: AiPermissionsSchema.parse({ drawingsEdit: true, chartRead: true }), getCandles: async () => candles,
      getState: () => ({ symbol: 'XAUUSD', timeframe: 'H1', bid: 20, ask: 20.1, spread: 0.1, feedStatus: 'connected', account: null, selectedDrawingId: null }),
    } as never;
    const zone = (extendRight: boolean, endTime: number) => ({ items: [{ kind: 'zone', a: { time: 100, price: 16 }, b: { time: endTime, price: 15 }, zoneType: 'demand', extendRight, reason: 'test zone' }] });
    const bad = await runAiTool(ctx, 'create_drawing', zone(true, 900));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toMatch(/no longer valid/);
    const ok = await runAiTool(ctx, 'create_drawing', zone(false, 400));
    expect(ok.ok).toBe(true);
  });
});
