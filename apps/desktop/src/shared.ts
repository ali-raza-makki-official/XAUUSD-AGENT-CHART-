import type {
  AlertCommand, AlertDispatchResult, AlertsSnapshot, FireRecord,
  AccountInfo, AppConfig, Candle, CalendarEvent, ConnectionTest, ConnectorHealth, ConnectorKind, ConnectorManifest, ConnectorResult, ContextSource,
  ActivityEntry, OrderRecord, PrepareResult,
  Drawing, FeedStatus, Indicator, LlmRequest, LlmResponse, NewsItem, ProviderId, RelatedMarkets, SentimentReading, SessionsSnapshot, SymbolSpec, Tick, Timeframe,
} from '@aurum/core';

import type { WhatsAppApi } from './whatsappShared';

export type ContextKindId = 'sessions' | 'calendar' | 'news' | 'sentiment' | 'related';
/** Everything the Context panel and the AI tools read. Each datapoint inside carries source + fetchedAt. */
export interface ContextSnapshot {
  at: number;
  sessions: ConnectorResult<SessionsSnapshot>;
  calendar: ContextSource<CalendarEvent>[];
  news: ContextSource<NewsItem>[];
  sentiment: ContextSource<SentimentReading>[];
  related: ConnectorResult<RelatedMarkets>;
}
/** What Settings shows per connector. Never contains a secret, only whether one is saved. */
export interface ConnectorStatus {
  id: string;
  name: string;
  kind: ConnectorKind;
  builtin: 'sessions' | 'related' | null;
  enabled: boolean;
  configured: boolean;
  issues: string[];
  health: ConnectorHealth;
  needsSecret: boolean;
  hasSecret: boolean;
  rateLimit: ConnectorManifest['rateLimit'];
  cacheTtlMs: number;
  permissions: ConnectorManifest['permissions'];
}

/** The only surface the renderer gets from the main process (see preload). */
export interface AurumApi extends WhatsAppApi {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  candles(tf: Timeframe, count: number): Promise<Candle[]>;
  findSymbols(query: string): Promise<string[]>;
  reconnect(): Promise<void>;
  symbolSpec(): Promise<SymbolSpec>;
  loadDrawings(symbol: string): Promise<{ drawings: Drawing[]; commandIds: string[] }>;
  persistDrawings(p: {
    symbol: string;
    log: { commandId: string; actor: 'manual' | 'ai'; kind: 'do' | 'undo' | 'redo'; label: string };
    changes: { id: string; after: Drawing | null }[];
  }): Promise<void>;
  loadIndicators(symbol: string): Promise<{ indicators: Indicator[]; commandIds: string[] }>;
  persistIndicators(p: {
    symbol: string;
    log: { commandId: string; actor: 'manual' | 'ai'; kind: 'do' | 'undo' | 'redo'; label: string };
    changes: { id: string; after: Indicator | null }[];
  }): Promise<void>;
  ordersState(): Promise<import('./main/orders').OrdersState>;
  ordersPrepare(command: unknown): Promise<PrepareResult>;
  ordersConfirm(commandId: string): Promise<OrderRecord>;
  ordersReconcile(commandId: string): Promise<OrderRecord>;
  ordersKill(on: boolean): Promise<void>;
  ordersActivity(): Promise<ActivityEntry[]>;
  aiStatus(): Promise<{ secureStorage: boolean; hasKey: Record<ProviderId, boolean> }>;
  aiSetKey(provider: ProviderId, key: string): Promise<void>;
  aiClearKey(provider: ProviderId): Promise<void>;
  aiListModels(provider: ProviderId): Promise<string[]>;
  aiTest(provider: ProviderId): Promise<{ ms: number; reply: string }>;
  aiChat(requestId: string, req: LlmRequest): Promise<LlmResponse>;
  aiAbort(requestId: string): Promise<void>;
  contextSnapshot(force?: boolean): Promise<ContextSnapshot>;
  contextRead<K extends ContextKindId>(kind: K, force?: boolean): Promise<ContextSnapshot[K]>;
  contextStatus(): Promise<ConnectorStatus[]>;
  contextTest(id: string): Promise<ConnectionTest>;
  contextRefresh(): Promise<void>;
  contextSetSecret(id: string, value: string): Promise<void>;
  contextClearSecret(id: string): Promise<void>;
  loadChat(): Promise<string | null>;
  saveChat(json: string): Promise<void>;
  alertsSnapshot(limit?: number): Promise<AlertsSnapshot>;
  alertsDispatch(cmd: AlertCommand): Promise<AlertDispatchResult>;
  alertsUndo(): Promise<boolean>;
  alertsRedo(): Promise<boolean>;
  alertsTestFire(id: string): Promise<{ ok: boolean; error?: string }>;
  onAlertsChanged(cb: (s: AlertsSnapshot) => void): () => void;
  onAlertFired(cb: (f: FireRecord) => void): () => void;
  onTick(cb: (t: Tick) => void): () => void;
  onStatus(cb: (s: FeedStatus) => void): () => void;
  onAccount(cb: (a: AccountInfo | null) => void): () => void;
  /** Latest values, so a window that mounts late does not wait for the next event. */
  snapshot(): Promise<{ status: FeedStatus; tick: Tick | null; account: AccountInfo | null }>;
}

export const IPC = {
  getConfig: 'cfg:get',
  setConfig: 'cfg:set',
  candles: 'feed:candles',
  findSymbols: 'feed:symbols',
  reconnect: 'feed:reconnect',
  symbolSpec: 'feed:spec',
  loadDrawings: 'db:drawings:load',
  persistDrawings: 'db:drawings:persist',
  loadIndicators: 'db:indicators:load',
  persistIndicators: 'db:indicators:persist',
  snapshot: 'feed:snapshot',
  ordersState: 'orders:state',
  ordersPrepare: 'orders:prepare',
  ordersConfirm: 'orders:confirm',
  ordersReconcile: 'orders:reconcile',
  ordersKill: 'orders:kill',
  ordersActivity: 'orders:activity',
  aiStatus: 'ai:status',
  aiSetKey: 'ai:setKey',
  aiClearKey: 'ai:clearKey',
  aiListModels: 'ai:models',
  aiTest: 'ai:test',
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  contextSnapshot: 'ctx:snapshot',
  contextRead: 'ctx:read',
  contextStatus: 'ctx:status',
  contextTest: 'ctx:test',
  contextRefresh: 'ctx:refresh',
  contextSetSecret: 'ctx:setSecret',
  contextClearSecret: 'ctx:clearSecret',
  loadChat: 'chat:load',
  saveChat: 'chat:save',
  alertsSnapshot: 'alerts:snapshot',
  alertsDispatch: 'alerts:dispatch',
  alertsUndo: 'alerts:undo',
  alertsRedo: 'alerts:redo',
  alertsTestFire: 'alerts:testFire',
  alertsChanged: 'alerts:changed',
  alertFired: 'alerts:fired',
  tick: 'feed:tick',
  status: 'feed:status',
  account: 'feed:account',
} as const;
