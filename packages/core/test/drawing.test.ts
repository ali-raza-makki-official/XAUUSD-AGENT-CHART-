import { describe, expect, it } from 'vitest';
import { DrawingStore, makeDrawing, positionIssues, rewardRisk, isShownOn, type Drawing } from '../src';

const hline = (id: string, price: number, actor: 'manual' | 'ai' = 'manual') =>
  makeDrawing({ kind: 'hline', price }, { id, actor, now: 1 });
let n = 0;
const cmd = (actor: 'manual' | 'ai', ops: any[], label = 't') => ({ commandId: `c-${++n}-xxxxxxxx`, actor, label, ops });

describe('DrawingStore', () => {
  it('creates, updates, deletes and undoes/redoes', () => {
    const s = new DrawingStore(() => 10);
    s.dispatch(cmd('manual', [{ op: 'create', drawing: hline('a', 100) }]));
    s.dispatch(cmd('manual', [{ op: 'update', id: 'a', patch: { price: 105, label: 'R1' } }]));
    expect((s.get('a') as any).price).toBe(105);
    s.undo();
    expect((s.get('a') as any).price).toBe(100);
    s.redo();
    expect((s.get('a') as any).label).toBe('R1');
    s.dispatch(cmd('manual', [{ op: 'delete', id: 'a' }]));
    expect(s.get('a')).toBeUndefined();
    s.undo();
    expect(s.get('a')).toBeDefined();
  });

  it('applies a batch atomically and undoes it as one step', () => {
    const s = new DrawingStore();
    const r = s.dispatch(cmd('ai', [
      { op: 'create', drawing: hline('a', 1, 'ai') },
      { op: 'create', drawing: hline('b', 2, 'ai') },
    ]));
    expect(r.ok).toBe(true);
    expect(s.list()).toHaveLength(2);
    s.undo();
    expect(s.list()).toHaveLength(0);
  });

  it('rejects the whole batch if one op is invalid', () => {
    const s = new DrawingStore();
    const r = s.dispatch(cmd('ai', [
      { op: 'create', drawing: hline('a', 1, 'ai') },
      { op: 'update', id: 'missing', patch: { price: 5 } },
    ]));
    expect(r.ok).toBe(false);
    expect(s.list()).toHaveLength(0);
  });

  it('ignores a duplicate command id (retry / double click)', () => {
    const s = new DrawingStore();
    const c = cmd('manual', [{ op: 'create', drawing: hline('a', 1) }]);
    s.dispatch(c);
    const again = s.dispatch(c);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(s.list()).toHaveLength(1);
  });

  it('stops the AI editing locked drawings or unlocking them', () => {
    const s = new DrawingStore();
    s.dispatch(cmd('manual', [{ op: 'create', drawing: hline('a', 1) }]));
    s.dispatch(cmd('manual', [{ op: 'update', id: 'a', patch: { locked: true } }]));
    expect(s.dispatch(cmd('ai', [{ op: 'update', id: 'a', patch: { price: 9 } }])).ok).toBe(false);
    expect(s.dispatch(cmd('ai', [{ op: 'delete', id: 'a' }])).ok).toBe(false);
    s.dispatch(cmd('manual', [{ op: 'update', id: 'a', patch: { locked: false } }]));
    expect(s.dispatch(cmd('ai', [{ op: 'update', id: 'a', patch: { locked: true } }])).ok).toBe(false);
    expect((s.get('a') as any).price).toBe(1);
  });

  it('keeps AI drawings on the AI layer and forbids changing layer/origin', () => {
    const s = new DrawingStore();
    expect(s.dispatch(cmd('ai', [{ op: 'create', drawing: hline('a', 1, 'manual') }])).ok).toBe(false);
    s.dispatch(cmd('manual', [{ op: 'create', drawing: hline('m', 1) }]));
    expect(s.dispatch(cmd('manual', [{ op: 'update', id: 'm', patch: { layer: 'ai' } }])).ok).toBe(false);
  });

  it('reverts only the AI changes since a time', () => {
    let t = 0;
    const s = new DrawingStore(() => t);
    t = 1; s.dispatch(cmd('manual', [{ op: 'create', drawing: hline('m', 1) }]));
    t = 2; s.dispatch(cmd('ai', [{ op: 'create', drawing: hline('x', 2, 'ai') }]));
    t = 3; s.dispatch(cmd('ai', [{ op: 'create', drawing: hline('y', 3, 'ai') }]));
    expect(s.revertActor('ai', 0)).toBe(2);
    expect(s.list().map((d) => d.id)).toEqual(['m']);
  });

  it('validates schema on update (bad colour rejected)', () => {
    const s = new DrawingStore();
    s.dispatch(cmd('manual', [{ op: 'create', drawing: hline('a', 1) }]));
    expect(s.dispatch(cmd('manual', [{ op: 'update', id: 'a', patch: { style: { color: 'red' } } }])).ok).toBe(false);
    expect(s.dispatch(cmd('manual', [{ op: 'update', id: 'a', patch: { style: { width: 3 } } }])).ok).toBe(true);
    expect((s.get('a') as Drawing).style.color).toBe('#d4af5a'); // merged, not replaced
  });
});

describe('drawing helpers', () => {
  it('AI drawings get the AI colour and layer by default', () => {
    const d = hline('a', 1, 'ai');
    expect(d.layer).toBe('ai');
    expect(d.style.color).toBe('#7fa8f5');
  });
  it('per-timeframe visibility', () => {
    const d = makeDrawing({ kind: 'hline', price: 1 }, { timeframes: ['H1', 'H4'] });
    expect(isShownOn(d, 'H1')).toBe(true);
    expect(isShownOn(d, 'M5')).toBe(false);
  });
  it('position checks sides and computes reward:risk', () => {
    const p = makeDrawing({ kind: 'position', side: 'buy', entryTime: 1, entry: 2000, stopLoss: 1995, takeProfits: [{ price: 2010, closePct: 50 }, { price: 2015, closePct: 50 }] }) as Extract<Drawing, { kind: 'position' }>;
    expect(positionIssues(p)).toEqual([]);
    expect(rewardRisk(p, 2010)).toBe(2);
    expect(positionIssues({ ...p, stopLoss: 2005 }).length).toBe(1);
    expect(positionIssues({ ...p, takeProfits: [{ price: 2010, closePct: 80 }, { price: 2015, closePct: 40 }] })[0]).toMatch(/more than 100/);
  });
});
