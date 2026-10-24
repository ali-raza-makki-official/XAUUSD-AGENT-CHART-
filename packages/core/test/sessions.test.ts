import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSIONS_SETTINGS, SessionsSettingsSchema, marketStatus, sessionIntervals, sessionsSnapshot, zonedToUtc, type SessionDef, type SessionsSettings } from '../src';

const t = (s: string) => Date.parse(s);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 16) + 'Z');
const def = (id: string): SessionDef => DEFAULT_SESSIONS_SETTINGS.sessions.find((s) => s.id === id)!;
const open = (id: string, at: string) => sessionsSnapshot(DEFAULT_SESSIONS_SETTINGS, t(at)).sessions.find((s) => s.id === id)!.inHours;

describe('time zone maths', () => {
  it('resolves spring-forward gaps and fall-back repeats', () => {
    expect(iso(zonedToUtc(2026, 3, 8, 2, 30, 'America/New_York'))).toBe('2026-03-08T07:30Z'); // 02:30 does not exist; lands at 03:30 EDT
    expect(iso(zonedToUtc(2026, 11, 1, 1, 30, 'America/New_York'))).toBe('2026-11-01T05:30Z'); // first 01:30 (EDT)
    expect(iso(zonedToUtc(2026, 1, 14, 8, 0, 'Europe/London'))).toBe('2026-01-14T08:00Z');
    expect(iso(zonedToUtc(2026, 7, 15, 8, 0, 'Europe/London'))).toBe('2026-07-15T07:00Z');
  });
});

describe('sessions follow DST by themselves', () => {
  it('London opens at 08:00Z in winter and 07:00Z in summer', () => {
    expect(open('london', '2026-01-14T07:59:00Z')).toBe(false);
    expect(open('london', '2026-01-14T08:00:00Z')).toBe(true);
    expect(open('london', '2026-07-15T06:59:00Z')).toBe(false);
    expect(open('london', '2026-07-15T07:00:00Z')).toBe(true);
  });

  it('London session shifts by an hour across the UK change (Fri 27 Mar GMT, Mon 30 Mar BST)', () => {
    const fri = sessionIntervals(def('london'), t('2026-03-27T00:00:00Z'), t('2026-03-28T00:00:00Z'))[0]!;
    const mon = sessionIntervals(def('london'), t('2026-03-30T00:00:00Z'), t('2026-03-31T00:00:00Z'))[0]!;
    expect([iso(fri.start), iso(fri.end)]).toEqual(['2026-03-27T08:00Z', '2026-03-27T17:00Z']);
    expect([iso(mon.start), iso(mon.end)]).toEqual(['2026-03-30T07:00Z', '2026-03-30T16:00Z']);
  });

  it('New York shifts at the US change (Fri 6 Mar EST, Mon 9 Mar EDT)', () => {
    const fri = sessionIntervals(def('newyork'), t('2026-03-06T00:00:00Z'), t('2026-03-07T00:00:00Z'))[0]!;
    const mon = sessionIntervals(def('newyork'), t('2026-03-09T00:00:00Z'), t('2026-03-10T00:00:00Z'))[0]!;
    expect(iso(fri.start)).toBe('2026-03-06T13:00Z');
    expect(iso(mon.start)).toBe('2026-03-09T12:00Z');
  });

  it('Sydney opens on the previous UTC day and moves when Australia leaves DST (5 Apr 2026)', () => {
    const before = sessionIntervals(def('sydney'), t('2026-03-02T00:00:00Z'), t('2026-03-03T00:00:00Z')).find((i) => i.start >= t('2026-03-01T00:00:00Z'))!;
    const after = sessionIntervals(def('sydney'), t('2026-04-13T00:00:00Z'), t('2026-04-14T00:00:00Z')).find((i) => i.start >= t('2026-04-12T00:00:00Z'))!;
    expect(iso(before.start)).toBe('2026-03-01T20:00Z'); // 07:00 AEDT (+11) on Monday
    expect(iso(after.start)).toBe('2026-04-12T21:00Z'); // 07:00 AEST (+10)
  });

  it('London/New York overlap is 13:00-17:00Z normally but 12:00-17:00Z in the weeks the two DST changes disagree', () => {
    const ov = (at: string) => { const o = sessionsSnapshot(DEFAULT_SESSIONS_SETTINGS, t(at)).overlaps.find((x) => x.ids.join() === 'london,newyork' && x.active)!; return [iso(o.start), iso(o.end)]; };
    expect(ov('2026-01-14T14:00:00Z')).toEqual(['2026-01-14T13:00Z', '2026-01-14T17:00Z']);
    expect(ov('2026-03-18T14:00:00Z')).toEqual(['2026-03-18T12:00Z', '2026-03-18T17:00Z']); // US on EDT, UK still GMT
    expect(ov('2026-10-28T14:00:00Z')).toEqual(['2026-10-28T12:00Z', '2026-10-28T17:00Z']); // UK back on GMT, US still EDT
    expect(ov('2026-07-15T14:00:00Z')).toEqual(['2026-07-15T12:00Z', '2026-07-15T16:00Z']);
  });
});

describe('current sessions, next open/close', () => {
  it('reports active sessions, time of next open and close', () => {
    const snap = sessionsSnapshot(DEFAULT_SESSIONS_SETTINGS, t('2026-01-14T14:30:00Z')); // Wed
    const active = snap.sessions.filter((s) => s.active).map((s) => s.id).sort();
    expect(active).toEqual(['london', 'newyork']);
    const ny = snap.sessions.find((s) => s.id === 'newyork')!;
    expect(iso(ny.nextClose)).toBe('2026-01-14T22:00Z');
    expect(iso(snap.sessions.find((s) => s.id === 'london')!.nextClose)).toBe('2026-01-14T17:00Z');
    expect(snap.upcoming[0]).toMatchObject({ type: 'close', sessionId: 'london' });
    expect(ny.localTime).toBe('09:30');
  });

  it('supports overnight sessions and disabling', () => {
    const s: SessionsSettings = SessionsSettingsSchema.parse({ sessions: [{ id: 'night', name: 'Night', tz: 'UTC', open: '22:00', close: '06:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true }] });
    const snap = sessionsSnapshot(s, t('2026-01-14T02:00:00Z'));
    expect(snap.sessions[0]).toMatchObject({ inHours: true });
    expect(iso(snap.sessions[0]!.currentEnd)).toBe('2026-01-14T06:00Z');
    expect(sessionsSnapshot({ ...s, sessions: [{ ...s.sessions[0]!, enabled: false }] }, t('2026-01-14T02:00:00Z')).sessions).toHaveLength(0);
  });

  it('rejects bad time zones and times in settings', () => {
    expect(SessionsSettingsSchema.safeParse({ sessions: [{ id: 'x1', name: 'X', tz: 'Mars/Base', open: '07:00', close: '16:00' }] }).success).toBe(false);
    expect(SessionsSettingsSchema.safeParse({ sessions: [{ id: 'x1', name: 'X', tz: 'UTC', open: '7am', close: '16:00' }] }).success).toBe(false);
  });
});

describe('weekend gap and closed windows', () => {
  const S = DEFAULT_SESSIONS_SETTINGS;
  it('is open Friday before 17:00 New York and closed until Sunday 17:00 New York', () => {
    const fri = marketStatus(S, t('2026-10-23T20:00:00Z'));
    expect(fri.state).toBe('open');
    expect(iso(fri.changesAt)).toBe('2026-10-23T21:00Z'); // 17:00 EDT
    const sat = marketStatus(S, t('2026-10-24T12:00:00Z'));
    expect(sat).toMatchObject({ state: 'closed', reason: 'weekend' });
    expect(iso(sat.changesAt)).toBe('2026-10-25T21:00Z'); // Sunday 17:00 EDT
    expect(marketStatus(S, t('2026-10-25T20:59:00Z')).state).toBe('closed');
    expect(marketStatus(S, t('2026-10-25T21:00:00Z')).state).toBe('open');
  });

  it('keeps the weekend gap right when DST changes inside it', () => {
    // US falls back on Sun 1 Nov 2026: Friday close is 17:00 EDT (21:00Z), reopening is 17:00 EST (22:00Z).
    const s = marketStatus(S, t('2026-10-31T10:00:00Z'));
    expect(iso(s.changesAt)).toBe('2026-11-01T22:00Z');
    expect(iso(marketStatus(S, t('2026-10-30T10:00:00Z')).changesAt)).toBe('2026-10-30T21:00Z');
    // US springs forward on Sun 8 Mar 2026: reopening is 17:00 EDT (21:00Z)
    expect(iso(marketStatus(S, t('2026-03-07T10:00:00Z')).changesAt)).toBe('2026-03-08T21:00Z');
  });

  it('sessions in hours are not "active" while gold is closed', () => {
    const noWeekdays: SessionsSettings = SessionsSettingsSchema.parse({ sessions: [{ id: 'always', name: 'Always', tz: 'UTC', open: '00:00', close: '23:59', days: [0, 1, 2, 3, 4, 5, 6] }] });
    const snap = sessionsSnapshot(noWeekdays, t('2026-10-24T12:00:00Z'));
    expect(snap.sessions[0]).toMatchObject({ inHours: true, active: false });
  });

  it('honours user-editable closed windows and chains them with the weekend', () => {
    const s = SessionsSettingsSchema.parse({ closedWindows: [{ id: 'xmas', label: 'Christmas Day (user entry)', start: '2026-12-25T00:00:00Z', end: '2026-12-26T00:00:00Z' }] });
    const before = marketStatus(s, t('2026-12-24T12:00:00Z'));
    expect(before.state).toBe('open');
    expect(iso(before.changesAt)).toBe('2026-12-25T00:00Z');
    const during = marketStatus(s, t('2026-12-25T10:00:00Z'));
    expect(during).toMatchObject({ state: 'closed', reason: 'closed_window', label: 'Christmas Day (user entry)' });
    expect(iso(during.changesAt)).toBe('2026-12-27T22:00Z'); // window, then the weekend, then Sunday 17:00 EST
  });

  it('can switch the weekly closure off', () => {
    const s = SessionsSettingsSchema.parse({ weeklyClosure: { enabled: false, tz: 'UTC', closeDay: 5, closeTime: '22:00', openDay: 0, openTime: '22:00' } });
    expect(marketStatus(s, t('2026-10-24T12:00:00Z')).state).toBe('open');
  });

  it('validates closed windows', () => {
    expect(SessionsSettingsSchema.safeParse({ closedWindows: [{ id: 'a', label: 'x', start: '2026-12-26T00:00:00Z', end: '2026-12-25T00:00:00Z' }] }).success).toBe(false);
    expect(SessionsSettingsSchema.safeParse({ closedWindows: [{ id: 'a', label: 'x', start: '2026-12-25 00:00', end: '2026-12-26T00:00:00Z' }] }).success).toBe(false);
  });
});
