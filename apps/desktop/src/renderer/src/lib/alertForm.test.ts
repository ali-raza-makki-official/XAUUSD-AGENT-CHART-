import { describe, expect, it } from 'vitest';
import { buildCondition, emptyForm, formFromCondition } from './alertForm';

describe('alert form', () => {
  it('builds a price cross and round-trips through formFromCondition', () => {
    const f = { ...emptyForm(), type: 'price_cross' as const, direction: 'below' as const, level: '2650.5' };
    const r = buildCondition(f);
    expect(r).toMatchObject({ ok: true, condition: { type: 'price_cross', direction: 'below', level: 2650.5, source: 'bid' } });
    if (r.ok) expect(buildCondition(formFromCondition(r.condition))).toEqual(r);
  });
  it('rejects an empty or non-positive level with a readable message', () => {
    expect(buildCondition({ ...emptyForm(), level: '' }).ok).toBe(false);
    expect(buildCondition({ ...emptyForm(), level: '-5' }).ok).toBe(false);
  });
  it('validates zone ranges, daily schedules and time zones', () => {
    expect(buildCondition({ ...emptyForm(), type: 'zone', zoneMode: 'range', low: '2660', high: '2650' }).ok).toBe(false);
    expect(buildCondition({ ...emptyForm(), type: 'zone', zoneMode: 'range', low: '2650', high: '2660' }).ok).toBe(true);
    expect(buildCondition({ ...emptyForm(), type: 'schedule', when: 'daily', time: '08:30', tz: 'Europe/London' }).ok).toBe(true);
    expect(buildCondition({ ...emptyForm(), type: 'schedule', when: 'daily', time: '08:30', tz: 'Nowhere/Land' }).ok).toBe(false);
    expect(buildCondition({ ...emptyForm(), type: 'schedule', when: 'once', at: '' }).ok).toBe(false);
  });
  it('needs a take-profit number for tp plans and a drawing for drawing targets', () => {
    expect(buildCondition({ ...emptyForm(), type: 'position_plan', drawingId: 'p1', planEvent: 'tp', tpIndex: '' }).ok).toBe(false);
    expect(buildCondition({ ...emptyForm(), type: 'position_plan', drawingId: 'p1', planEvent: 'tp', tpIndex: '2' }).ok).toBe(true);
    expect(buildCondition({ ...emptyForm(), type: 'trendline', drawingId: '' }).ok).toBe(false);
  });
});
