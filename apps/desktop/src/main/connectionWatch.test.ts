import { describe, expect, it } from 'vitest';
import { ConnectionWatcher } from './connectionWatch';

function rig(graceMs = 20_000) {
  let t = 0; const timers: { fn: () => void; at: number; live: boolean }[] = []; const sent: string[] = [];
  const w = new ConnectionWatcher({
    notify: (text, p) => sent.push(`${p}:${text}`), now: () => t, graceMs,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; }, clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  const advance = (ms: number) => { t += ms; for (const x of timers) if (x.live && x.at <= t) { x.live = false; x.fn(); } };
  return { w, sent, advance };
}
const up = { state: 'connected' } as const, down = { state: 'disconnected' } as const;

describe('ConnectionWatcher', () => {
  it('says nothing before the first connection', () => {
    const r = rig(); r.w.onStatus(down); r.advance(60_000); expect(r.sent).toEqual([]);
  });
  it('ignores a drop that heals within the grace period', () => {
    const r = rig(); r.w.onStatus(up); r.w.onStatus(down); r.advance(10_000); r.w.onStatus(up); r.advance(60_000); expect(r.sent).toEqual([]);
  });
  it('announces one loss and one recovery per outage, and treats stale as up', () => {
    const r = rig(); r.w.onStatus(up);
    r.w.onStatus(down); r.w.onStatus({ state: 'error' }); r.advance(25_000);
    expect(r.sent).toHaveLength(1); expect(r.sent[0]).toMatch(/^critical:MT5 connection lost/);
    r.advance(180_000); r.w.onStatus({ state: 'stale' });
    expect(r.sent).toHaveLength(2); expect(r.sent[1]).toMatch(/^normal:MT5 is connected again \(it was away about 3 min\)/);
    r.w.onStatus(up); expect(r.sent).toHaveLength(2);
    r.w.onStatus(down); r.advance(25_000); expect(r.sent).toHaveLength(3); // a second outage is announced again
  });
});
