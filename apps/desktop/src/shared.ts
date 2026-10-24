import type { AccountInfo, AppConfig, Candle, Drawing, FeedStatus, SymbolSpec, Tick, Timeframe } from '@aurum/core';

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
  tick: 'feed:tick',
  status: 'feed:status',
  account: 'feed:account',
} as const;
