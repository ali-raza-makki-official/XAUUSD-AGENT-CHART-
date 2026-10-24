import type { AccountInfo, AppConfig, Candle, Drawing, FeedStatus, LlmRequest, LlmResponse, ProviderId, SymbolSpec, Tick, Timeframe } from '@aurum/core';

/** The only surface the renderer gets from the main process (see preload). */
export interface AurumApi {
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
  aiStatus(): Promise<{ secureStorage: boolean; hasKey: Record<ProviderId, boolean> }>;
  aiSetKey(provider: ProviderId, key: string): Promise<void>;
  aiClearKey(provider: ProviderId): Promise<void>;
  aiListModels(provider: ProviderId): Promise<string[]>;
  aiTest(provider: ProviderId): Promise<{ ms: number; reply: string }>;
  aiChat(requestId: string, req: LlmRequest): Promise<LlmResponse>;
  aiAbort(requestId: string): Promise<void>;
  loadChat(): Promise<string | null>;
  saveChat(json: string): Promise<void>;
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
  snapshot: 'feed:snapshot',
  aiStatus: 'ai:status',
  aiSetKey: 'ai:setKey',
  aiClearKey: 'ai:clearKey',
  aiListModels: 'ai:models',
  aiTest: 'ai:test',
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  loadChat: 'chat:load',
  saveChat: 'chat:save',
  tick: 'feed:tick',
  status: 'feed:status',
  account: 'feed:account',
} as const;
