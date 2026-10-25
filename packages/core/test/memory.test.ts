import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, memoryDigest, searchMemory, stripContext } from '../src';

describe('memory helpers', () => {
  it('strips the context line', () => expect(stripContext('[context] XAUUSD M5 | bid 1\n\nhello')).toBe('hello'));
  it('ranks by matched words then recency, and returns nothing for no overlap', () => {
    const items = [{ text: 'bought gold at the london open', ts: 1 }, { text: 'london open fade worked', ts: 3 }, { text: 'lunch', ts: 9 }];
    expect(searchMemory('london open fade', items).map((i) => i.ts)).toEqual([3, 1]);
    expect(searchMemory('zzz', items)).toEqual([]);
  });
  it('caps the digest and is empty without content', () => {
    expect(memoryDigest([], null)).toBe('');
    const notes = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, kind: 'fact' as const, text: `note number ${i} `.repeat(3), weight: 3, source: 'ai' as const, createdAt: i }));
    expect(memoryDigest(notes, null, 600).length).toBeLessThan(900);
  });
  it('puts the digest in the system prompt only when given', () => {
    const base = { symbol: 'XAUUSD', brokerSymbol: 'XAUUSD', readOnly: false, canDraw: true, orderMode: 'suggest' as const };
    expect(buildSystemPrompt(base)).not.toContain('What you remember');
    expect(buildSystemPrompt({ ...base, memory: memoryDigest([{ id: 'a', kind: 'preference', text: 'Uses 70 pip stops', weight: 3, source: 'user', createdAt: 1 }], null) })).toContain('Uses 70 pip stops');
  });
});
