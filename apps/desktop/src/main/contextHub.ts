import {
  ConnectorRegistry, configIssues, createHttpGet, makeGenericConnector, makeRelatedMarketsConnector, makeSessionsConnector,
  type AppConfig, type CalendarEvent, type ConnectionTest, type ContextSource, type ContextFeed, type GenericConnectorConfig,
  type NewsItem, type SentimentReading,
} from '@aurum/core';
import type { BridgeManager } from './bridge';
import { deleteContextCache, loadContextCache, saveContextCache } from './db';
import { clearConnectorSecret, getConnectorSecret, hasConnectorSecret } from './secrets';
import type { ConnectorStatus, ContextKindId, ContextSnapshot } from '../shared';

const SESSIONS_ID = 'sessions';
const RELATED_ID = 'related-markets';
const TICK_MS = 15_000;

/** Signature of everything that decides WHAT a feed returns. A change invalidates the cached data. */
const sig = (c: GenericConnectorConfig) => JSON.stringify([c.kind, c.format, c.url, c.authHeader, c.mapping]);

/**
 * Owns the connector registry in the main process: registers the built-in and user-defined connectors,
 * keeps them in step with settings, reads secrets, persists the last real fetch, and refreshes in the background
 * through the registry (so every call obeys the rate limit and Retry-After).
 */
export class ContextHub {
  readonly registry: ConnectorRegistry;
  private sigs = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private http = createHttpGet();

  constructor(private getConfig: () => AppConfig, private bridge: BridgeManager) {
    this.registry = new ConnectorRegistry({
      onFetched: (id, e) => {
        const s = this.sigs.get(id);
        if (!s) return; // only user feeds are persisted; sessions and live quotes are not
        try { saveContextCache(id, { source: e.source, fetchedAt: e.fetchedAt, sig: s, data: e.data }); } catch (err) { console.error('[context] cache write failed:', err instanceof Error ? err.message : err); }
      },
    });
    this.registry.register(makeSessionsConnector({ getSettings: () => this.getConfig().context.sessions }));
    this.registry.register(makeRelatedMarketsConnector({ getSettings: () => this.getConfig().context.related, fetchQuotes: (s) => this.bridge.quotes(s) }));
    this.sync();
  }

  private generic(): GenericConnectorConfig[] { return this.getConfig().context.connectors; }

  /** Reconcile the registry with settings. Call after every settings change. */
  sync(): void {
    const ctx = this.getConfig().context;
    this.registry.setEnabled(SESSIONS_ID, ctx.sessionsEnabled);
    this.registry.setEnabled(RELATED_ID, ctx.relatedEnabled);
    const wanted = new Map(ctx.connectors.map((c) => [c.id, c]));
    for (const id of [...this.sigs.keys()]) {
      if (!wanted.has(id)) {
        this.registry.unregister(id); this.sigs.delete(id);
        try { deleteContextCache(id); clearConnectorSecret(id); } catch { /* nothing stored */ }
      }
    }
    for (const c of ctx.connectors) {
      const s = sig(c);
      if (this.sigs.get(c.id) !== s) {
        if (this.sigs.has(c.id)) { this.registry.unregister(c.id); try { deleteContextCache(c.id); } catch { /* none */ } }
        this.sigs.set(c.id, s);
        this.registry.register(
          makeGenericConnector(() => this.generic().find((x) => x.id === c.id) ?? c, { http: this.http, getSecret: getConnectorSecret }) as never,
        );
        try {
          const cached = loadContextCache(c.id);
          if (cached && cached.sig === s) this.registry.seed(c.id, cached);
        } catch { /* no cache is fine */ }
      }
      this.registry.setEnabled(c.id, c.enabled);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), TICK_MS);
    void this.refresh();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Background refresh. The registry decides whether a call is due (TTL) and allowed (rate limit). */
  async refresh(force = false): Promise<void> {
    const ids = [RELATED_ID, ...this.generic().filter((c) => c.enabled).map((c) => c.id)];
    await Promise.all(ids.map((id) => (this.registry.isEnabled(id) ? this.registry.read(id, { force }) : null)));
  }

  private async feeds<T>(kind: GenericConnectorConfig['kind'], force: boolean): Promise<ContextSource<T>[]> {
    const mine = this.generic().filter((c) => c.kind === kind && c.enabled);
    return Promise.all(mine.map(async (c) => ({ id: c.id, name: c.label, result: await this.registry.read<ContextFeed<T>>(c.id, { force }) })));
  }

  read<K extends ContextKindId>(kind: K, force = false): Promise<ContextSnapshot[K]> {
    const r = (kind === 'sessions' ? this.registry.read(SESSIONS_ID, { force })
      : kind === 'related' ? this.registry.read(RELATED_ID, { force })
      : this.feeds(kind, force)) as Promise<ContextSnapshot[K]>;
    return r;
  }

  async snapshot(force = false): Promise<ContextSnapshot> {
    const [sessions, calendar, news, sentiment, related] = await Promise.all([
      this.read('sessions', force), this.feeds<CalendarEvent>('calendar', force), this.feeds<NewsItem>('news', force),
      this.feeds<SentimentReading>('sentiment', force), this.read('related', force),
    ]);
    return { at: Date.now(), sessions, calendar, news, sentiment, related };
  }

  status(): ConnectorStatus[] {
    const ctx = this.getConfig().context;
    const out: ConnectorStatus[] = [];
    const push = (id: string, builtin: ConnectorStatus['builtin'], issues: string[], needsSecret: boolean) => {
      const m = this.registry.manifest(id);
      const health = this.registry.health(id);
      if (!m || !health) return;
      out.push({ id, name: m.name, kind: m.kind, builtin, enabled: health.enabled, configured: health.configured, issues, health, needsSecret, hasSecret: needsSecret && hasConnectorSecret(id), rateLimit: m.rateLimit, cacheTtlMs: m.cacheTtlMs, permissions: m.permissions });
    };
    push(SESSIONS_ID, 'sessions', [], false);
    push(RELATED_ID, 'related', Object.keys(ctx.related.symbols).length ? [] : ['Map at least one market to your broker symbol.'], false);
    for (const c of ctx.connectors) push(c.id, null, configIssues(c), c.authHeader !== null || c.url.includes('{{secret}}'));
    return out;
  }

  test(id: string): Promise<ConnectionTest> { return this.registry.test(id); }
}
