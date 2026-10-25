import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';
import { MemoryService } from './memory';

const make = () => { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); let t = Date.UTC(2026, 0, 1); return { m: new MemoryService(() => db, () => (t += 60_000)), tick: (ms: number) => { t += ms; } }; };

describe('MemoryService', () => {
  it('archives turns without the [context] line and finds them by keywords days later', () => {
    const { m, tick } = make();
    m.log({ channel: 'app', role: 'user', text: '[context] XAUUSD M5 | bid 1\n\nI never trade the Friday evening session after losing twice' });
    m.log({ channel: 'whatsapp', role: 'assistant', text: 'Noted: no Friday evening trades.' });
    tick(20 * 86_400_000);
    const r = m.recall('Friday evening', 365);
    expect(r.chats).toHaveLength(2);
    expect(r.chats[0]!.text).not.toContain('[context]');
    expect(m.recall('Friday evening', 5).chats).toHaveLength(0); // outside the window
    expect(m.recall('banana', 365).chats).toHaveLength(0);
  });
  it('remember dedupes, orders by weight in the digest, and clear wipes notes and archive', () => {
    const { m } = make();
    m.remember({ kind: 'preference', text: 'Prefers 70 pip stops', weight: 2, source: 'user' });
    m.remember({ kind: 'preference', text: 'prefers 70 pip stops', weight: 5, source: 'ai' });
    m.remember({ kind: 'lesson', text: 'Revenge trades after two losses', weight: 4, source: 'review' });
    expect(m.notes()).toHaveLength(2);
    const d = m.digest('42 paper trades judged');
    expect(d.indexOf('70 pip')).toBeLessThan(d.indexOf('Revenge'));
    expect(d).toContain('(measured) 42 paper trades judged');
    m.log({ channel: 'app', role: 'user', text: 'hello there' });
    m.clear();
    expect(m.stats()).toEqual({ turns: 0, notes: 0, first: null });
    expect(m.digest(null)).toBe('');
  });
});
