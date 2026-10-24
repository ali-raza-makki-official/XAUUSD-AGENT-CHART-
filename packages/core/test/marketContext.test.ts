import { describe, expect, it } from 'vitest';
import {
  MappingSchema, NoTradeRuleSchema, extractRows, feedToNews, filterByCurrency, filterByImpact, inNoTradeWindow, mapRows, nextHours,
  nextNoTradeWindow, noTradeWindows, normalizeImpact, parseFeed, parseTime, queryPath, requireItems, type CalendarEvent,
} from '../src';

// Fixtures below are shaped by hand for these tests only. They are not a real provider's format.
const sec = (s: string) => Math.floor(Date.parse(s) / 1000);

describe('JSONPath-like queries', () => {
  const doc = { data: { events: [{ id: 1, meta: { t: 'a' }, tags: ['x', 'y'] }, { id: 2, meta: { t: 'b' }, tags: [] }] }, 'odd key': 5 };
  it('supports keys, indexes, wildcards, brackets and recursive descent', () => {
    expect(queryPath(doc, '$.data.events[*].id')).toEqual([1, 2]);
    expect(queryPath(doc, '$.data.events[1].meta.t')).toEqual(['b']);
    expect(queryPath(doc, '$.data.events[-1].id')).toEqual([2]);
    expect(queryPath(doc, "$['odd key']")).toEqual([5]);
    expect(queryPath(doc, '$..t')).toEqual(['a', 'b']);
    expect(queryPath(doc, '$.data.events[0].tags[*]')).toEqual(['x', 'y']);
    expect(queryPath(doc, '$.missing.deeper')).toEqual([]);
  });
  it('rejects malformed paths and prototype access', () => {
    expect(() => queryPath(doc, 'data.events')).toThrow();
    expect(() => queryPath(doc, '$.a[')).toThrow();
    expect(queryPath({}, '$.__proto__')).toEqual([]);
    expect(MappingSchema.safeParse({ itemsPath: '$.a[?(@.x)]' }).success).toBe(false);
  });
});

describe('time and impact normalisation', () => {
  const m = { timeFormat: 'auto' as const, timeZone: 'UTC' };
  it('handles unix s/ms, ISO with offset, RFC 822, and naive strings in the configured zone', () => {
    expect(parseTime(1_790_000_000, m)).toBe(1_790_000_000);
    expect(parseTime(1_790_000_000_000, m)).toBe(1_790_000_000);
    expect(parseTime('1790000000', m)).toBe(1_790_000_000);
    expect(parseTime('2026-10-23T12:30:00Z', m)).toBe(sec('2026-10-23T12:30:00Z'));
    expect(parseTime('2026-10-23T08:30:00-04:00', m)).toBe(sec('2026-10-23T12:30:00Z'));
    expect(parseTime('Fri, 23 Oct 2026 12:30:00 GMT', m)).toBe(sec('2026-10-23T12:30:00Z'));
    expect(parseTime('2026-10-23 08:30:00', { ...m, timeZone: 'America/New_York' })).toBe(sec('2026-10-23T12:30:00Z'));
    expect(parseTime('2026-10-23 12:30', m)).toBe(sec('2026-10-23T12:30:00Z'));
  });
  it('refuses what it cannot place in time instead of guessing', () => {
    expect(parseTime('tomorrow', m)).toBeNull();
    expect(parseTime('10/23/2026 12:30', m)).toBeNull(); // would depend on the machine zone
    expect(parseTime(null, m)).toBeNull();
    expect(parseTime('', m)).toBeNull();
  });
  it('maps impact words and numbers, unknown stays unknown', () => {
    expect(['High', '3', 'red', 'Medium', 'moderate', 'Low', '1', 'Holiday', null].map((v) => normalizeImpact(v))).toEqual(['high', 'high', 'high', 'medium', 'medium', 'low', 'low', 'unknown', 'unknown']);
    expect(normalizeImpact('Holiday', { holiday: 'low' })).toBe('low');
  });
});

describe('mapping JSON into typed schemas', () => {
  const calendarJson = { result: { events: [
    { when: '2026-10-23 08:30:00', ccy: 'usd', name: 'Core PCE Price Index m/m', imp: 'High', a: 0.3, f: '0.2%', p: '0.1%' },
    { when: '2026-10-23 10:00:00', ccy: 'EUR', name: 'Consumer Confidence', imp: 'Low', a: null, f: '-14', p: '-15' },
    { when: 'soon', ccy: 'USD', name: 'Bad time', imp: 'High' },
    { when: '2026-10-23 12:00:00', ccy: 'USDX', name: 'Bad currency', imp: 'High' },
    { when: '2026-10-23 12:00:00', ccy: 'USD', imp: 'High' },
  ] } };
  const mapping = MappingSchema.parse({
    itemsPath: '$.result.events[*]', timeZone: 'America/New_York',
    fields: { time: '$.when', currency: '$.ccy', title: '$.name', impact: '$.imp', actual: '$.a', forecast: '$.f', previous: '$.p' },
  });

  it('normalises calendar rows, counts and drops invalid ones', () => {
    const r = mapRows('calendar', extractRows(calendarJson, mapping), mapping, 'Test');
    expect(r.total).toBe(5);
    expect(r.rejected).toBe(3);
    expect(r.items[0]).toEqual({ time: sec('2026-10-23T12:30:00Z'), currency: 'USD', title: 'Core PCE Price Index m/m', impact: 'high', actual: '0.3', forecast: '0.2%', previous: '0.1%' });
    expect(r.items[1]).toMatchObject({ currency: 'EUR', impact: 'low', actual: null });
  });

  it('unwraps an itemsPath that points at the array node itself', () => {
    const m2 = MappingSchema.parse({ ...mapping, itemsPath: '$.result.events' });
    expect(extractRows(calendarJson, m2)).toHaveLength(5);
  });

  it('news: uses constants and the connector label as source, rejects non-http urls', () => {
    const m = MappingSchema.parse({ itemsPath: '$.items[*]', fields: { time: '$.ts', title: '$.h', url: '$.u', summary: '$.s' } });
    const r = mapRows('news', extractRows({ items: [
      { ts: 1_790_000_000, h: 'Gold firms', u: 'https://example.test/a', s: 'x' },
      { ts: 1_790_000_100, h: 'Evil', u: 'javascript:alert(1)' },
    ] }, m), m, 'My feed');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ title: 'Gold firms', source: 'My feed', url: 'https://example.test/a' });
    expect(r.rejected).toBe(1);
  });

  it('sentiment: needs both sides as numbers, accepts % strings and a user-stated instrument constant', () => {
    const m = MappingSchema.parse({ itemsPath: '$[*]', fields: { longPct: '$.long', shortPct: '$.short', asOf: '$.at' }, constants: { instrument: 'XAUUSD' } });
    const r = mapRows('sentiment', extractRows([{ long: '62%', short: 38, at: '2026-10-23T12:00:00Z' }, { long: 'n/a', short: 38 }, { long: 130, short: -30 }], m), m, 'Broker X');
    expect(r.items).toEqual([{ source: 'Broker X', instrument: 'XAUUSD', longPct: 62, shortPct: 38, asOf: sec('2026-10-23T12:00:00Z') }]);
    expect(r.rejected).toBe(2);
  });

  it('errors when nothing matches, rather than returning an empty success that hides a bad mapping', () => {
    const wrongPath = MappingSchema.parse({ ...mapping, itemsPath: '$.nope[*]' });
    expect(() => requireItems(mapRows('calendar', extractRows(calendarJson, wrongPath), wrongPath, 'T'), 'T')).toThrow(/matched no rows/);
    const wrongFields = MappingSchema.parse({ ...mapping, fields: { time: '$.zzz', title: '$.zzz', currency: '$.zzz' } });
    expect(() => requireItems(mapRows('calendar', extractRows(calendarJson, wrongFields), wrongFields, 'T'), 'T')).toThrow(/none matched/);
  });
});

describe('RSS and Atom', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
    <item><title><![CDATA[Fed &amp; markets: rates]]></title><link>https://example.test/1</link><description>&lt;p&gt;Policy &lt;b&gt;statement&lt;/b&gt; &amp;amp; more&lt;/p&gt;</description><pubDate>Fri, 23 Oct 2026 12:30:00 GMT</pubDate></item>
    <item><title>No date item</title><link>https://example.test/2</link></item>
  </channel></rss>`;
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Gold &#8212; up</title><link rel="alternate" href="https://example.test/atom/1"/><summary>Short</summary><updated>2026-10-23T09:00:00+02:00</updated></entry></feed>`;

  it('parses RSS 2.0 with CDATA, entities, tags in summaries', () => {
    const items = parseFeed(rss);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'Fed & markets: rates', link: 'https://example.test/1', published: 'Fri, 23 Oct 2026 12:30:00 GMT' });
    expect(items[0]!.summary).toBe('Policy statement & more');
  });
  it('parses Atom', () => {
    const [e] = parseFeed(atom);
    expect(e).toMatchObject({ title: 'Gold — up', link: 'https://example.test/atom/1', summary: 'Short', published: '2026-10-23T09:00:00+02:00' });
  });
  it('maps to NewsItem and drops items without a usable time', () => {
    const r = feedToNews(parseFeed(rss), 'Example RSS');
    expect(r.items).toHaveLength(1);
    expect(r.rejected).toBe(1);
    expect(r.items[0]).toMatchObject({ time: sec('2026-10-23T12:30:00Z'), source: 'Example RSS', url: 'https://example.test/1' });
    expect(feedToNews(parseFeed(atom), 'A').items[0]!.time).toBe(sec('2026-10-23T07:00:00Z'));
  });
  it('rejects things that are not feeds (an HTML error page)', () => {
    expect(() => parseFeed('<html><body>Not found</body></html>')).toThrow(/not an RSS/);
  });
});

describe('filters and no-trade windows', () => {
  const ev = (time: string, currency: string, impact: CalendarEvent['impact'], title = 'E'): CalendarEvent => ({ time: sec(time), currency, impact, title, actual: null, forecast: null, previous: null });
  const events = [
    ev('2026-10-23T12:30:00Z', 'USD', 'high', 'NFP'),
    ev('2026-10-23T12:40:00Z', 'USD', 'high', 'Unemployment'),
    ev('2026-10-23T14:00:00Z', 'USD', 'medium', 'ISM'),
    ev('2026-10-23T09:00:00Z', 'EUR', 'high', 'EUR CPI'),
    ev('2026-10-24T18:00:00Z', 'USD', 'high', 'FOMC'),
    ev('2026-10-23T13:00:00Z', 'GBP', 'unknown', 'Mystery'),
  ];
  it('filters by impact, currency and horizon', () => {
    expect(filterByImpact(events, 'high')).toHaveLength(4);
    expect(filterByImpact(events, 'medium')).toHaveLength(5);
    expect(filterByImpact(events, 'low').some((e) => e.impact === 'unknown')).toBe(false);
    expect(filterByCurrency(events, ['usd', 'XAU']).map((e) => e.title)).toEqual(['NFP', 'Unemployment', 'ISM', 'FOMC']);
    const now = Date.parse('2026-10-23T12:00:00Z');
    expect(nextHours(events, now, 3).map((e) => e.title)).toEqual(['NFP', 'Unemployment', 'Mystery', 'ISM']);
  });
  it('builds merged no-trade windows only around qualifying events', () => {
    const rule = NoTradeRuleSchema.parse({ beforeMinutes: 15, afterMinutes: 30 });
    const w = noTradeWindows(events, rule);
    expect(w).toHaveLength(2); // EUR is not a gold-relevant currency; NFP and Unemployment merge
    expect(new Date(w[0]!.start).toISOString()).toBe('2026-10-23T12:15:00.000Z');
    expect(new Date(w[0]!.end).toISOString()).toBe('2026-10-23T13:10:00.000Z');
    expect(w[0]!.events.map((e) => e.title)).toEqual(['NFP', 'Unemployment']);
    expect(inNoTradeWindow(w, Date.parse('2026-10-23T12:20:00Z'))?.events).toHaveLength(2);
    expect(inNoTradeWindow(w, Date.parse('2026-10-23T13:10:00Z'))).toBeNull();
    expect(nextNoTradeWindow(w, Date.parse('2026-10-23T13:10:00Z'))?.events[0]?.title).toBe('FOMC');
  });
  it('adds currencies and impact levels when the user asks', () => {
    const w = noTradeWindows(events, NoTradeRuleSchema.parse({ minImpact: 'medium', currencies: ['USD', 'EUR'] }));
    expect(w.flatMap((x) => x.events.map((e) => e.title))).toContain('EUR CPI');
    expect(w.flatMap((x) => x.events.map((e) => e.title))).toContain('ISM');
  });
  it('returns nothing without calendar data (no invented windows)', () => {
    expect(noTradeWindows([], NoTradeRuleSchema.parse({}))).toEqual([]);
  });
});
