import { describe, expect, it } from 'vitest';
import { tickBriefing, type BriefingSettings } from './briefingScheduler';

const S: BriefingSettings = { enabled: true, time: '08:00', tz: 'UTC', weekdaysOnly: true };
function rig(nowIso: string, over: Partial<BriefingSettings> = {}, sentBefore: string | null = null) {
  let last = sentBefore; let sends = 0;
  const run = () => tickBriefing({ settings: () => ({ ...S, ...over }), lastSent: () => last, markSent: (d) => { last = d; }, send: async () => { sends++; return true; }, now: () => Date.parse(nowIso) });
  return { run, sends: () => sends, last: () => last };
}

describe('briefing scheduler', () => {
  it('sends once at the chosen time and not again that day', async () => {
    const r = rig('2026-10-21T08:03:00Z');
    expect(await r.run()).toBe(true); expect(await r.run()).toBe(false);
    expect(r.sends()).toBe(1); expect(r.last()).toBe('2026-10-21');
  });
  it('does not send early, very late, on weekends, or when turned off', async () => {
    expect(await rig('2026-10-21T07:59:00Z').run()).toBe(false);
    expect(await rig('2026-10-21T09:30:00Z').run()).toBe(false); // app was closed at 08:00: skip
    expect(await rig('2026-10-24T08:01:00Z').run()).toBe(false); // Saturday
    expect(await rig('2026-10-21T08:01:00Z', { enabled: false }).run()).toBe(false);
  });
  it('uses the chosen time zone', async () => {
    expect(await rig('2026-10-21T12:02:00Z', { tz: 'America/New_York' }).run()).toBe(true); // 08:02 in New York (EDT)
    expect(await rig('2026-10-21T08:02:00Z', { tz: 'America/New_York' }).run()).toBe(false); // 04:02 there
  });
  it('invalid time zone does nothing', async () => {
    expect(await rig('2026-10-21T08:00:00Z', { tz: 'Not/AZone' }).run()).toBe(false);
  });
});
