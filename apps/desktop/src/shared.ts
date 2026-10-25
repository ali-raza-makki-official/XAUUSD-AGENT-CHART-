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
  /** Commands whose result is unknown (the broker may or may not have executed them). */
  ordersUnresolved(): Promise<OrderRecord[]>;
  /** The owner checked MT5 by hand and decides what happened. Logged. */
  ordersResolve(commandId: string, outcome: 'confirmed' | 'rejected', note: string): Promise<OrderRecord>;
  ordersKill(on: boolean): Promise<void>;
  /** Real closed deals from MT5 for the last N days (for the journal and performance statistics). */
  /** Remember the pre-trade checklist the user saw when confirming an order. */
  journalSaveCheck(commandId: string, snapshot: JournalCheckSnapshot): Promise<void>;
  journalChecks(): Promise<{ commandId: string; positionId: number | null; snapshot: JournalCheckSnapshot; at: number }[]>;
  /** Named JSON documents: 'user_view' (your market view) and 'ai_view' (the AI's last analysis). */
  kvGet(key: 'user_view' | 'ai_view'): Promise<string | null>;
  kvSet(key: 'user_view' | 'ai_view', json: string): Promise<void>;
  /** Start Aurum automatically when the user signs in to Windows. */
  autoStartGet(): Promise<boolean>;
  autoStartSet(on: boolean): Promise<boolean>;
  // Trade Assistant (plans in pips, ask-or-act at the zone, pip-based management)
  assistList(): Promise<import('@aurum/core').TradePlan[]>;
  assistCreate(input: AssistPlanInput): Promise<import('@aurum/core').TradePlan>;
  assistApprove(id: string, autoTake: boolean): Promise<import('@aurum/core').TradePlan>;
  assistCancel(id: string): Promise<import('@aurum/core').TradePlan>;
  assistTake(id: string): Promise<import('@aurum/core').TradePlan>;
  assistSkip(id: string): Promise<import('@aurum/core').TradePlan>;
  assistPips(): Promise<AssistPipRow[]>;
  onAssistEvent(cb: (e: { text: string; priority: 'critical' | 'normal' }) => void): () => void;
  onAssistAsk(cb: (e: { plan: import('@aurum/core').TradePlan; text: string }) => void): () => void;
  onAssistChanged(cb: () => void): () => void;
  paperList(): Promise<import('@aurum/core').PaperTrade[]>;
  paperRecord(idea: PaperIdea): Promise<import('@aurum/core').PaperTrade>;
  learnInsights(force?: boolean): Promise<LearnInsights>;
  learnApply(slPips: number, tpPips: number): Promise<AppConfig>;
  learnRevert(): Promise<{ ok: boolean; config: AppConfig }>;
  onConfigChanged(cb: (c: AppConfig) => void): () => void;
  memoryLog(e: { channel: 'app' | 'whatsapp'; role: 'user' | 'assistant'; text: string }): Promise<void>;
  memoryRemember(n: { kind: 'lesson' | 'preference' | 'fact'; text: string; weight: number; source?: 'user' | 'ai' | 'review' }): Promise<import('@aurum/core').MemoryNote>;
  memoryRecall(query: string, days: number): Promise<{ notes: { kind: string; text: string }[]; chats: { when: string; channel: string; role: string; text: string }[] }>;
  memoryNotes(): Promise<import('@aurum/core').MemoryNote[]>;
  memoryForget(id: string): Promise<void>;
  memoryClear(): Promise<void>;
  memoryDigest(): Promise<string>;
  memoryStats(): Promise<{ turns: number; notes: number; first: number | null }>;
  tickStats(): Promise<{ count: number; first: number | null; last: number | null; approxBytes: number }>;
  onPaperChanged(cb: () => void): () => void;
  ordersHistory(days: number): Promise<import('@aurum/core').BrokerDeal[]>;
  ordersActivity(): Promise<ActivityEntry[]>;
  eaInfo(): Promise<{ port: number; token: string; connected: boolean }>;
  aiStatus(): Promise<{ secureStorage: boolean; hasKey: Record<ProviderId, boolean> }>;
  aiSetKey(provider: ProviderId, key: string): Promise<void>;
  aiClearKey(provider: ProviderId): Promise<void>;
  aiListModels(provider: ProviderId): Promise<string[]>;
  aiTest(provider: ProviderId): Promise<{ ms: number; reply: string }>;
  /** What the chosen model understands, and who turns a voice note into text. */
  aiCaps(): Promise<AiCapsInfo>;
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
  ordersReconcile: 'orders:reconcile', ordersUnresolved: 'orders:unresolved', ordersResolve: 'orders:resolve',
  ordersKill: 'orders:kill',
  ordersHistory: 'orders:history',
  paperList: 'paper:list', paperRecord: 'paper:record', learnInsights: 'learn:insights', learnApply: 'learn:apply', learnRevert: 'learn:revert', configChanged: 'config:changed', tickStats: 'ticks:stats', memoryLog: 'memory:log', memoryRemember: 'memory:remember', memoryRecall: 'memory:recall', memoryNotes: 'memory:notes', memoryForget: 'memory:forget', memoryClear: 'memory:clear', memoryDigest: 'memory:digest', memoryStats: 'memory:stats', paperChanged: 'paper:changed',
  assistList: 'assist:list', assistCreate: 'assist:create', assistApprove: 'assist:approve', assistCancel: 'assist:cancel', assistTake: 'assist:take', assistSkip: 'assist:skip', assistPips: 'assist:pips',
  assistEvent: 'assist:event', assistAsk: 'assist:ask', assistChanged: 'assist:changed',
  autoStartGet: 'app:autoStartGet',
  autoStartSet: 'app:autoStartSet',
  kvGet: 'kv:get',
  kvSet: 'kv:set',
  journalSaveCheck: 'journal:saveCheck',
  journalChecks: 'journal:checks',
  ordersActivity: 'orders:activity',
  eaInfo: 'ea:info',
  aiStatus: 'ai:status',
  aiSetKey: 'ai:setKey',
  aiClearKey: 'ai:clearKey',
  aiListModels: 'ai:models',
  aiTest: 'ai:test',
  aiCaps: 'ai:caps',
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

export interface AiCapsInfo { provider: ProviderId | null; model: string; vision: boolean; pdf: boolean; audioIn: boolean; /** Who transcribes voice notes: the chat model itself, another provider's speech-to-text, or nobody. */ voice: { by: 'model' | 'openai' | 'gemini' | null } }

export interface JournalCheckSnapshot { items: { id: string; label: string; status: 'pass' | 'fail' | 'warn' | 'unknown' }[]; acknowledged: boolean; ticked: string[] }

export interface AssistPlanInput { side: 'buy' | 'sell'; zone: { low: number; high: number }; entry?: 'touch' | 'limit'; slPips?: number; tpPips?: number | null; riskPct?: number; autoTake?: boolean; expiryHours?: number; note?: string }
export interface AssistPipRow { ticket: number; side: 'buy' | 'sell'; lots: number; open: number; pips: number | null; slPips: number | null; tpPips: number | null }

export interface PaperIdea { source: 'analysis' | 'user'; side: 'buy' | 'sell'; zone: { low: number; high: number }; slPips: number; tpPips: number | null; entry?: 'touch' | 'limit'; note?: string }
export type LearnInsights = import('./main/learning').Insights;
