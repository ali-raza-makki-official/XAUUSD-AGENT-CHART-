import { z } from 'zod';

/**
 * Universal connector contract (PRODUCT_PROFILE section 14). Pure: no network, no timers, no Electron.
 * A connector declares a manifest, can test itself, and fetches typed data. The registry adds enable/disable,
 * a per-connector token bucket (honouring Retry-After), TTL caching, stale flagging and a fixed error taxonomy.
 *
 * Rule: a connector never invents data. On failure it throws a ConnectorError and the UI says "unavailable".
 * The only non-fresh data ever returned is the last REAL fetch, flagged `stale: true` with its original fetchedAt.
 */

export const CONNECTOR_KINDS = ['broker', 'ai', 'news', 'calendar', 'related_markets', 'sentiment', 'messaging', 'storage'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const ConnectorManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,63}$/, 'id: lowercase letters, digits, . _ -'),
  name: z.string().min(1).max(80),
  kind: z.enum(CONNECTOR_KINDS),
  version: z.string().min(1).max(20),
  capabilities: z.array(z.string().min(1).max(40)).max(20),
  /** Names of secrets the connector needs from the secret store. Values never appear in a manifest. */
  requiredSecrets: z.array(z.string().min(1).max(40)).max(8),
  /** What the connector is allowed to touch. Anything not listed is not available to it. */
  permissions: z.array(z.enum(['network', 'mt5_bridge', 'local_clock', 'storage'])).max(4),
  rateLimit: z.object({
    /** Burst size. */
    capacity: z.number().int().min(1).max(1000),
    refillPerMinute: z.number().positive().max(6000),
  }),
  /** Reuse cached data younger than this. 0 = always fetch. */
  cacheTtlMs: z.number().int().min(0),
  /** Data older than this is flagged stale in every result. */
  staleAfterMs: z.number().int().min(1),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export type ConnectorErrorCode =
  | 'not_configured' // user has not supplied what is needed (URL, mapping, symbol)
  | 'disabled' // switched off in settings
  | 'unauthorized' // 401/403 or missing/invalid secret
  | 'rate_limited' // our bucket or the provider said wait
  | 'network' // could not reach the provider
  | 'timeout'
  | 'bad_response' // reached it, but the payload did not match the schema
  | 'upstream' // provider-side error (5xx, MT5 down)
  | 'unsupported' // unknown connector / unsupported operation
  | 'internal';

export interface ErrorInfo { code: ConnectorErrorCode; message: string; retryAfterMs?: number }

export class ConnectorError extends Error implements ErrorInfo {
  constructor(public code: ConnectorErrorCode, message: string, public retryAfterMs?: number) {
    super(message);
    this.name = 'ConnectorError';
  }
  toInfo(): ErrorInfo { return { code: this.code, message: this.message, ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}) }; }
}

export const toErrorInfo = (e: unknown): ErrorInfo =>
  e instanceof ConnectorError ? e.toInfo() : { code: 'internal', message: e instanceof Error ? e.message : String(e) };

/** Every datapoint handed out by a connector carries who said it and when we fetched it. */
export interface Stamp { source: string; fetchedAt: number }
export type Stamped<T> = T & Stamp;
export const stampAll = <T extends object>(items: T[], source: string, fetchedAt: number): Stamped<T>[] => items.map((i) => ({ ...i, source: (i as { source?: string }).source ?? source, fetchedAt }));

export type ConnectorResult<T> =
  | ({ ok: true; data: T; /** older than the manifest's staleAfterMs, or served after a failed refresh */ stale: boolean; fromCache: boolean; /** why a refresh did not happen, if it did not */ lastError?: ErrorInfo } & Stamp)
  | { ok: false; error: ErrorInfo; source: string };

export type ConnectionTest = { ok: true; at: number; latencyMs: number; detail: string } | { ok: false; at: number; error: ErrorInfo };

export interface Connector<T = unknown> {
  manifest: ConnectorManifest;
  /** Has the user supplied everything required (URL, mapping, secret, symbol mapping)? */
  isConfigured(): boolean;
  /** One real round-trip. Must not return success unless the provider answered with data that validates. */
  testConnection(): Promise<ConnectionTest>;
  /** Throws ConnectorError. Items inside T must already carry Stamp where they are lists of datapoints. */
  fetch(): Promise<T>;
}

export interface ConnectorHealth {
  id: string;
  enabled: boolean;
  configured: boolean;
  lastSuccessfulSync: number | null;
  errorStatus: ErrorInfo | null;
  /** Earliest time a call is allowed (rate limit / Retry-After), or null when a call may go out now. */
  nextAllowedCall: number | null;
  stale: boolean;
  lastTest: ConnectionTest | null;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(public readonly capacity: number, public readonly refillPerMs: number, now: number) {
    this.tokens = capacity;
    this.last = now;
  }
  private refill(now: number) {
    if (now > this.last) { this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs); this.last = now; }
  }
  /** Take one token, or say how long until one is available. */
  take(now: number): { ok: true } | { ok: false; waitMs: number } {
    this.refill(now);
    if (this.tokens >= 1) { this.tokens -= 1; return { ok: true }; }
    return { ok: false, waitMs: Math.ceil((1 - this.tokens) / this.refillPerMs) };
  }
  available(now: number): number { this.refill(now); return this.tokens; }
}

const MAX_RETRY_AFTER_MS = 24 * 3600_000;
/** Retry-After is either delta-seconds or an HTTP date. Returns ms to wait, or null if unusable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.min(Math.max(0, t - now), MAX_RETRY_AFTER_MS);
}

interface Entry { data: unknown; fetchedAt: number; source: string }
interface State {
  connector: Connector;
  enabled: boolean;
  bucket: TokenBucket;
  cache: Entry | null;
  lastSuccess: number | null;
  error: ErrorInfo | null;
  blockedUntil: number;
  lastTest: ConnectionTest | null;
  inflight: Promise<ConnectorResult<unknown>> | null;
}

export interface RegistryDeps {
  now?: () => number;
  /** Called after each successful real fetch so the host can persist it (SQLite cache). */
  onFetched?: (id: string, entry: { data: unknown; fetchedAt: number; source: string }) => void;
}

export class ConnectorRegistry {
  private states = new Map<string, State>();
  private now: () => number;
  constructor(private deps: RegistryDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  register(connector: Connector, opts: { enabled?: boolean } = {}): void {
    const m = ConnectorManifestSchema.parse(connector.manifest);
    if (this.states.has(m.id)) throw new Error(`Connector '${m.id}' is already registered.`);
    // Never enabled by default: the owner switches each connector on.
    this.states.set(m.id, {
      connector, enabled: opts.enabled ?? false,
      bucket: new TokenBucket(m.rateLimit.capacity, m.rateLimit.refillPerMinute / 60_000, this.now()),
      cache: null, lastSuccess: null, error: null, blockedUntil: 0, lastTest: null, inflight: null,
    });
  }

  unregister(id: string): void { this.states.delete(id); }
  has(id: string): boolean { return this.states.has(id); }
  list(): ConnectorManifest[] { return [...this.states.values()].map((s) => s.connector.manifest); }
  manifest(id: string): ConnectorManifest | null { return this.states.get(id)?.connector.manifest ?? null; }

  setEnabled(id: string, enabled: boolean): void {
    const s = this.states.get(id);
    if (!s) throw new Error(`Unknown connector '${id}'.`);
    s.enabled = enabled;
  }
  isEnabled(id: string): boolean { return this.states.get(id)?.enabled ?? false; }

  /** Restore a previously persisted real fetch so the UI has something (flagged stale if old) after a restart. */
  seed(id: string, entry: { data: unknown; fetchedAt: number; source: string }): void {
    const s = this.states.get(id);
    if (s && !s.cache) { s.cache = entry; s.lastSuccess = s.lastSuccess ?? entry.fetchedAt; }
  }

  health(id: string): ConnectorHealth | null {
    const s = this.states.get(id);
    if (!s) return null;
    const now = this.now();
    const avail = s.bucket.available(now);
    const next = Math.max(s.blockedUntil, avail >= 1 ? 0 : now + Math.ceil((1 - avail) / s.bucket.refillPerMs));
    return {
      id, enabled: s.enabled, configured: s.connector.isConfigured(), lastSuccessfulSync: s.lastSuccess,
      errorStatus: s.error, nextAllowedCall: next > now ? next : null,
      stale: !!s.cache && now - s.cache.fetchedAt > s.connector.manifest.staleAfterMs, lastTest: s.lastTest,
    };
  }

  private fail<T>(s: State, e: ErrorInfo, now: number): ConnectorResult<T> {
    const m = s.connector.manifest;
    if (s.cache) {
      return { ok: true, data: s.cache.data as T, source: s.cache.source, fetchedAt: s.cache.fetchedAt, stale: true, fromCache: true, lastError: e };
    }
    void now;
    return { ok: false, error: e, source: m.name };
  }

  /** Read through the registry: enabled check, cache, rate limit, fetch, stale handling. Never throws. */
  async read<T>(id: string, opts: { force?: boolean } = {}): Promise<ConnectorResult<T>> {
    const s = this.states.get(id);
    if (!s) return { ok: false, error: { code: 'unsupported', message: `Unknown connector '${id}'.` }, source: id };
    const m = s.connector.manifest;
    const now = this.now();
    if (!s.enabled) return { ok: false, error: { code: 'disabled', message: `${m.name} is turned off.` }, source: m.name };
    if (!s.connector.isConfigured()) return { ok: false, error: { code: 'not_configured', message: `${m.name} is not configured.` }, source: m.name };

    if (s.cache && !opts.force && now - s.cache.fetchedAt < m.cacheTtlMs) {
      return { ok: true, data: s.cache.data as T, source: s.cache.source, fetchedAt: s.cache.fetchedAt, stale: now - s.cache.fetchedAt > m.staleAfterMs, fromCache: true };
    }
    if (s.inflight) return s.inflight as Promise<ConnectorResult<T>>;

    if (now < s.blockedUntil) {
      return this.fail<T>(s, { code: 'rate_limited', message: `${m.name}: provider asked us to wait.`, retryAfterMs: s.blockedUntil - now }, now);
    }
    const tok = s.bucket.take(now);
    if (!tok.ok) return this.fail<T>(s, { code: 'rate_limited', message: `${m.name}: local rate limit reached.`, retryAfterMs: tok.waitMs }, now);

    const run = (async (): Promise<ConnectorResult<T>> => {
      try {
        const data = (await s.connector.fetch()) as T;
        const fetchedAt = this.now();
        s.cache = { data, fetchedAt, source: m.name };
        s.lastSuccess = fetchedAt;
        s.error = null;
        this.deps.onFetched?.(id, s.cache);
        return { ok: true, data, source: m.name, fetchedAt, stale: false, fromCache: false };
      } catch (e) {
        const info = toErrorInfo(e);
        s.error = info;
        if (info.code === 'rate_limited' && info.retryAfterMs) s.blockedUntil = this.now() + info.retryAfterMs;
        return this.fail<T>(s, info, this.now());
      } finally {
        s.inflight = null;
      }
    })();
    s.inflight = run;
    return run;
  }

  /** Connection test. Uses a rate-limit token like any call, and records the outcome in health. */
  async test(id: string): Promise<ConnectionTest> {
    const s = this.states.get(id);
    const at = this.now();
    if (!s) return { ok: false, at, error: { code: 'unsupported', message: `Unknown connector '${id}'.` } };
    if (!s.connector.isConfigured()) return (s.lastTest = { ok: false, at, error: { code: 'not_configured', message: `${s.connector.manifest.name} is not configured.` } });
    if (at < s.blockedUntil) return (s.lastTest = { ok: false, at, error: { code: 'rate_limited', message: 'Provider asked us to wait.', retryAfterMs: s.blockedUntil - at } });
    const tok = s.bucket.take(at);
    if (!tok.ok) return (s.lastTest = { ok: false, at, error: { code: 'rate_limited', message: 'Local rate limit reached.', retryAfterMs: tok.waitMs } });
    let r: ConnectionTest;
    try { r = await s.connector.testConnection(); } catch (e) { r = { ok: false, at: this.now(), error: toErrorInfo(e) }; }
    if (!r.ok) {
      s.error = r.error;
      if (r.error.code === 'rate_limited' && r.error.retryAfterMs) s.blockedUntil = this.now() + r.error.retryAfterMs;
    }
    return (s.lastTest = r);
  }
}
