import { z } from 'zod';
import { ConnectorError } from './connectors';
import { isValidTimeZone, zonedToUtc } from './tz';

/**
 * Typed schemas for market context (calendar, news, sentiment, related markets), a small JSONPath-like
 * evaluator, an RSS/Atom reader, field mapping into the schemas, and pure filter helpers.
 * Nothing here talks to the network and nothing here invents values: a row that does not validate is dropped
 * and counted, and a payload where nothing validates is an error.
 */

// ---- schemas -------------------------------------------------------------------------------------

export const IMPACTS = ['low', 'medium', 'high', 'unknown'] as const;
export type Impact = (typeof IMPACTS)[number];
const IMPACT_RANK: Record<Impact, number> = { unknown: 0, low: 1, medium: 2, high: 3 };

const Http = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'http(s) only');
const Val = z.string().max(40).nullable();

/** time: unix seconds, UTC. actual/forecast/previous stay as the provider wrote them ("2.5%", "225K"), never re-parsed. */
export const CalendarEventSchema = z.object({
  time: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  title: z.string().min(1).max(200),
  impact: z.enum(IMPACTS),
  actual: Val,
  forecast: Val,
  previous: Val,
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const NewsItemSchema = z.object({
  time: z.number().int(),
  title: z.string().min(1).max(300),
  summary: z.string().max(600).default(''),
  url: Http.max(1000).nullable().default(null),
  source: z.string().min(1).max(80),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

/** longPct/shortPct 0..100 as the provider reported them. asOf null = the provider did not say. */
export const SentimentReadingSchema = z.object({
  source: z.string().min(1).max(80),
  instrument: z.string().min(1).max(40),
  longPct: z.number().min(0).max(100),
  shortPct: z.number().min(0).max(100),
  asOf: z.number().int().nullable(),
});
export type SentimentReading = z.infer<typeof SentimentReadingSchema>;

// ---- JSONPath-like -------------------------------------------------------------------------------

type Seg = { t: 'key'; k: string } | { t: 'idx'; i: number } | { t: 'all' } | { t: 'deep'; k: string };

/** Supported: $  .key  ['key']  [0]  [-1]  [*]  .*  ..key  (no filters or slices, by design). */
export function parsePath(path: string): Seg[] {
  if (!path.startsWith('$')) throw new Error(`Path must start with $ (got '${path}')`);
  const segs: Seg[] = [];
  let i = 1;
  while (i < path.length) {
    if (path.startsWith('..', i)) {
      const m = /^\.\.([A-Za-z0-9_$-]+)/.exec(path.slice(i));
      if (!m) throw new Error(`Bad recursive segment at ${i} in '${path}'`);
      segs.push({ t: 'deep', k: m[1]! }); i += m[0].length;
    } else if (path[i] === '.') {
      const m = /^\.([A-Za-z0-9_$-]+|\*)/.exec(path.slice(i));
      if (!m) throw new Error(`Bad segment at ${i} in '${path}'`);
      segs.push(m[1] === '*' ? { t: 'all' } : { t: 'key', k: m[1]! }); i += m[0].length;
    } else if (path[i] === '[') {
      const m = /^\[(?:(\*)|(-?\d+)|'([^']*)'|"([^"]*)")\]/.exec(path.slice(i));
      if (!m) throw new Error(`Bad bracket at ${i} in '${path}'`);
      segs.push(m[1] ? { t: 'all' } : m[2] !== undefined ? { t: 'idx', i: Number(m[2]) } : { t: 'key', k: (m[3] ?? m[4])! }); i += m[0].length;
    } else throw new Error(`Unexpected '${path[i]}' at ${i} in '${path}'`);
  }
  return segs;
}

export const JsonPathSchema = z.string().min(1).max(200).refine((p) => { try { parsePath(p); return true; } catch { return false; } }, 'Invalid path. Use forms like $.events[*], $.data.items[0].title, $..price');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function deep(node: unknown, k: string, out: unknown[], depth = 0): void {
  if (depth > 20) return;
  if (Array.isArray(node)) node.forEach((n) => deep(n, k, out, depth + 1));
  else if (isObj(node)) {
    if (Object.hasOwn(node, k)) out.push(node[k]);
    for (const v of Object.values(node)) deep(v, k, out, depth + 1);
  }
}

export function queryPath(root: unknown, path: string): unknown[] {
  let cur: unknown[] = [root];
  for (const s of parsePath(path)) {
    const next: unknown[] = [];
    for (const n of cur) {
      if (s.t === 'key') { if (isObj(n) && !FORBIDDEN.has(s.k) && Object.hasOwn(n, s.k)) next.push(n[s.k]); }
      else if (s.t === 'idx') { if (Array.isArray(n)) { const v = n[s.i < 0 ? n.length + s.i : s.i]; if (v !== undefined) next.push(v); } }
      else if (s.t === 'all') { if (Array.isArray(n)) next.push(...n); else if (isObj(n)) next.push(...Object.values(n)); }
      else deep(n, s.k, next);
    }
    cur = next;
  }
  return cur;
}

// ---- mapping spec --------------------------------------------------------------------------------

export const MappingSchema = z.object({
  /** Where the list of rows is, e.g. $.events[*] or $[*]. */
  itemsPath: JsonPathSchema,
  /** Target field -> path relative to ONE row (starts with $). */
  fields: z.record(z.string().max(30), JsonPathSchema).default({}),
  /** Fixed values the user states (e.g. instrument: "XAUUSD" for a feed that does not repeat it). */
  constants: z.record(z.string().max(30), z.union([z.string().max(100), z.number()])).default({}),
  timeFormat: z.enum(['auto', 'iso', 'unix_s', 'unix_ms']).default('auto'),
  /** IANA zone for date strings that carry no offset. Default UTC. */
  timeZone: z.string().refine(isValidTimeZone, 'Unknown IANA time zone').default('UTC'),
  /** Extra impact words -> level, e.g. {"red":"high"}. */
  impactMap: z.record(z.string().max(30), z.enum(IMPACTS)).default({}),
});
export type Mapping = z.infer<typeof MappingSchema>;

/** Seconds since epoch (UTC) from a provider value, or null if it cannot be understood. */
export function parseTime(v: unknown, m: Pick<Mapping, 'timeFormat' | 'timeZone'>): number | null {
  if (v === null || v === undefined || v === '') return null;
  const asNum = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  if (asNum !== null && (m.timeFormat === 'auto' || m.timeFormat === 'unix_s' || m.timeFormat === 'unix_ms')) {
    if (!Number.isFinite(asNum)) return null;
    const ms = m.timeFormat === 'unix_ms' || (m.timeFormat === 'auto' && Math.abs(asNum) > 1e11) ? asNum : asNum * 1000;
    return ms > 0 && ms < 4.2e12 ? Math.floor(ms / 1000) : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/(Z|[+-]\d\d:?\d\d|GMT|UTC|[A-Z]{3,4})$/.test(s) && !/^\d{4}-\d\d-\d\d$/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  const n = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(s); // no offset: use the configured zone
  if (n) return Math.floor(zonedToUtc(+n[1]!, +n[2]!, +n[3]!, +(n[4] ?? 0), +(n[5] ?? 0), m.timeZone) / 1000);
  return null; // anything else would depend on the machine's own time zone, so it is rejected
}

export function normalizeImpact(v: unknown, extra: Record<string, Impact> = {}): Impact {
  if (v === null || v === undefined) return 'unknown';
  const s = String(v).trim().toLowerCase();
  if (Object.hasOwn(extra, s)) return extra[s]!;
  if (/^(high|h|3|red|high impact.*)$/.test(s)) return 'high';
  if (/^(medium|med|m|moderate|2|orange|medium impact.*)$/.test(s)) return 'medium';
  if (/^(low|l|1|yellow|low impact.*)$/.test(s)) return 'low';
  return 'unknown';
}

const str = (v: unknown, max = 40): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.trim().slice(0, max) || null : null;
};
const pct = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = Number(v.replace('%', '').trim()); return v.trim() !== '' && Number.isFinite(n) ? n : null; }
  return null;
};
const first = (row: unknown, path: string | undefined): unknown => (path ? queryPath(row, path)[0] : undefined);

export interface Mapped<T> { items: T[]; total: number; rejected: number }
export type ContextKind = 'calendar' | 'news' | 'sentiment';

/** Pick the raw rows out of a parsed JSON document. */
export function extractRows(json: unknown, m: Mapping): unknown[] {
  const rows = queryPath(json, m.itemsPath);
  // $.events (an array node) -> unwrap; $.events[*] already yields the rows
  return rows.length === 1 && Array.isArray(rows[0]) ? (rows[0] as unknown[]) : rows;
}

/** Normalise raw JSON rows into the typed schema for a kind. Rows failing validation are dropped and counted. */
export function mapRows(kind: 'calendar', rows: unknown[], m: Mapping, label: string): Mapped<CalendarEvent>;
export function mapRows(kind: 'news', rows: unknown[], m: Mapping, label: string): Mapped<NewsItem>;
export function mapRows(kind: 'sentiment', rows: unknown[], m: Mapping, label: string): Mapped<SentimentReading>;
export function mapRows(kind: ContextKind, rows: unknown[], m: Mapping, label: string): Mapped<CalendarEvent | NewsItem | SentimentReading> {
  const out: (CalendarEvent | NewsItem | SentimentReading)[] = [];
  let rejected = 0;
  for (const row of rows.slice(0, 2000)) {
    const get = (f: string): unknown => first(row, m.fields[f]) ?? m.constants[f];
    let cand: unknown;
    if (kind === 'calendar') {
      const cur = str(get('currency'), 12);
      cand = {
        time: parseTime(get('time'), m), currency: cur ? cur.toUpperCase() : null, title: str(get('title'), 200),
        impact: normalizeImpact(get('impact'), m.impactMap), actual: str(get('actual')), forecast: str(get('forecast')), previous: str(get('previous')),
      };
    } else if (kind === 'news') {
      cand = { time: parseTime(get('time'), m), title: str(get('title'), 300), summary: str(get('summary'), 600) ?? '', url: str(get('url'), 1000), source: str(get('source'), 80) ?? label };
    } else {
      cand = { source: str(get('source'), 80) ?? label, instrument: str(get('instrument')), longPct: pct(get('longPct')), shortPct: pct(get('shortPct')), asOf: parseTime(get('asOf'), m) };
    }
    const schema = kind === 'calendar' ? CalendarEventSchema : kind === 'news' ? NewsItemSchema : SentimentReadingSchema;
    const r = schema.safeParse(cand);
    if (r.success) out.push(r.data); else rejected++;
  }
  return { items: out, total: rows.length, rejected };
}

/** Throws bad_response when rows existed but none validated, or when the path matched nothing. */
export function requireItems<T>(r: Mapped<T>, what: string): T[] {
  if (r.total === 0) throw new ConnectorError('bad_response', `${what}: the items path matched no rows. Check the mapping against the real response.`);
  if (r.items.length === 0) throw new ConnectorError('bad_response', `${what}: ${r.total} rows came back but none matched the required fields. Check the field mapping.`);
  return r.items;
}

// ---- RSS / Atom ----------------------------------------------------------------------------------

export interface FeedItem { title: string; link: string | null; summary: string; published: string | null }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const c = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const cdataOrText = (s: string) => {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1]! : decode(s);
};
const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? cdataOrText(m[1]!) : null;
};

/** Small tolerant RSS 2.0 / RSS 1.0 / Atom reader. Not a full XML parser; it never fetches or expands entities. */
export function parseFeed(xml: string): FeedItem[] {
  if (xml.length > 3_000_000) throw new ConnectorError('bad_response', 'Feed is larger than 3 MB.');
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new ConnectorError('bad_response', 'The response is not an RSS or Atom feed.');
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const b of blocks.slice(0, 500)) {
    const title = tag(b, 'title');
    if (!title) continue;
    let link = tag(b, 'link');
    if (!link || !link.trim()) { const m = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(b); link = m ? decode(m[1]!) : null; }
    const summary = stripTags(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content') ?? '');
    items.push({ title: stripTags(title), link: link?.trim() || null, summary: summary.slice(0, 600), published: tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date') });
  }
  return items;
}

export function feedToNews(items: FeedItem[], label: string, m: Pick<Mapping, 'timeFormat' | 'timeZone'> = { timeFormat: 'auto', timeZone: 'UTC' }): Mapped<NewsItem> {
  return mapRows('news', items.map((i) => ({ time: i.published, title: i.title, summary: i.summary, url: i.link })), { itemsPath: '$[*]', fields: { time: '$.time', title: '$.title', summary: '$.summary', url: '$.url' }, constants: {}, impactMap: {}, ...m }, label);
}

// ---- filters (pure) ------------------------------------------------------------------------------

export const GOLD_RELEVANT_CURRENCIES = ['USD', 'XAU'] as const;

export const atLeast = (impact: Impact, min: Impact): boolean => IMPACT_RANK[impact] >= IMPACT_RANK[min];
export const filterByImpact = <T extends { impact: Impact }>(events: T[], min: Impact): T[] => events.filter((e) => atLeast(e.impact, min));
export const filterByCurrency = <T extends { currency: string }>(events: T[], currencies: readonly string[]): T[] => {
  const set = new Set(currencies.map((c) => c.toUpperCase()));
  return events.filter((e) => set.has(e.currency.toUpperCase()));
};
/** Events from `now` up to now + hours (unix seconds in, unix seconds on events). */
export const nextHours = <T extends { time: number }>(events: T[], nowMs: number, hours: number): T[] =>
  events.filter((e) => e.time * 1000 >= nowMs && e.time * 1000 <= nowMs + hours * 3600_000).sort((a, b) => a.time - b.time);

export const NoTradeRuleSchema = z.object({
  minImpact: z.enum(['low', 'medium', 'high']).default('high'),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(20).default([...GOLD_RELEVANT_CURRENCIES]),
  beforeMinutes: z.number().int().min(0).max(240).default(15),
  afterMinutes: z.number().int().min(0).max(240).default(15),
});
export type NoTradeRule = z.infer<typeof NoTradeRuleSchema>;
export const DEFAULT_NO_TRADE_RULE: NoTradeRule = NoTradeRuleSchema.parse({});

export interface NoTradeWindow { start: number; end: number; events: { time: number; title: string; currency: string; impact: Impact }[] }

/** Windows (unix ms) around qualifying events; overlapping windows are merged. Pure: only what the calendar says. */
export function noTradeWindows(events: CalendarEvent[], rule: NoTradeRule): NoTradeWindow[] {
  const sel = filterByCurrency(filterByImpact(events, rule.minImpact), rule.currencies).sort((a, b) => a.time - b.time);
  const out: NoTradeWindow[] = [];
  for (const e of sel) {
    const start = e.time * 1000 - rule.beforeMinutes * 60_000;
    const end = e.time * 1000 + rule.afterMinutes * 60_000;
    const ev = { time: e.time, title: e.title, currency: e.currency, impact: e.impact };
    const last = out[out.length - 1];
    if (last && start <= last.end) { last.end = Math.max(last.end, end); last.events.push(ev); } else out.push({ start, end, events: [ev] });
  }
  return out;
}

export const inNoTradeWindow = (windows: NoTradeWindow[], nowMs: number): NoTradeWindow | null => windows.find((w) => nowMs >= w.start && nowMs < w.end) ?? null;
export const nextNoTradeWindow = (windows: NoTradeWindow[], nowMs: number): NoTradeWindow | null => windows.find((w) => w.start > nowMs) ?? null;
