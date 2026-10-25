import { EventEmitter } from 'node:events';
import {
  AccountInfoSchema, VIRTUAL_TIMEFRAMES, aggregateCandles, isVirtualTimeframe,
  CandlesResponseSchema,
  SymbolSpecSchema,
  STALE_AFTER_SECONDS,
  TickSchema,
  type AccountInfo,
  type Candle,
  type SymbolSpec,
  type FeedStatus,
  type Tick,
  type Timeframe,
} from '@aurum/core';

const TICK_POLL_MS = 500;
const ACCOUNT_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface BridgeEvents {
  tick: [Tick];
  status: [FeedStatus];
  account: [AccountInfo | null];
}

/** Polls the local EA hub (eaHub.ts) and reports real feed state. Never produces data itself. */
export class BridgeManager extends EventEmitter<BridgeEvents> {
  private port = 0;
  private token = '';
  private timer: NodeJS.Timeout | null = null;
  private accountTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private lastAccountTry = 0;
  private lastTickTime = 0;
  private lastTickChangeAt = 0;
  status: FeedStatus = { state: 'starting' };
  lastTick: Tick | null = null;
  account: AccountInfo | null = null;

  /** Begin polling the hub's local HTTP interface. The hub reports "EA not connected" until the MT5 EA registers. */
  async start(hub: { port: number; token: string }): Promise<void> {
    await this.stop();
    const gen = ++this.generation;
    this.setStatus({ state: 'starting', message: 'Waiting for the MT5 EA…' });
    this.port = hub.port;
    this.token = hub.token;
    this.timer = setInterval(() => void this.pollTick(gen), TICK_POLL_MS);
    this.accountTimer = setInterval(() => void this.pollAccount(gen), ACCOUNT_POLL_MS);
    void this.pollAccount(gen);
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.accountTimer) clearInterval(this.accountTimer);
    this.timer = this.accountTimer = null;
    this.lastTick = null;
    this.lastTickTime = 0;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      headers: { 'X-Aurum-Token': this.token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `bridge HTTP ${res.status}`);
    return body;
  }

  private setStatus(s: FeedStatus): void {
    if (s.state === this.status.state && s.message === this.status.message) return;
    this.status = s;
    this.emit('status', s);
  }

  private async pollTick(gen: number): Promise<void> {
    try {
      const tick = TickSchema.parse(await this.get('/tick'));
      if (gen !== this.generation) return;
      if (tick.time !== this.lastTickTime) {
        this.lastTickTime = tick.time;
        this.lastTickChangeAt = Date.now();
      }
      this.lastTick = tick;
      this.emit('tick', tick);
      // The first account poll can run before the bridge is up, so retry quickly until we have one.
      if (!this.account && Date.now() - this.lastAccountTry > 1000) void this.pollAccount(gen);
      const quietFor = (Date.now() - this.lastTickChangeAt) / 1000;
      if (quietFor > STALE_AFTER_SECONDS) {
        this.setStatus({ state: 'stale', message: `No new tick for ${Math.round(quietFor)}s (market may be closed)` });
      } else {
        this.setStatus({ state: 'connected', message: 'MT5 connected' });
      }
    } catch (e) {
      if (gen !== this.generation) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Connection-refused right after spawn just means the bridge is still booting.
      const booting = /ECONNREFUSED|fetch failed/i.test(msg) && this.status.state === 'starting';
      if (!booting) this.setStatus({ state: 'disconnected', message: msg });
    }
  }

  private async pollAccount(gen: number): Promise<void> {
    this.lastAccountTry = Date.now();
    try {
      const acc = AccountInfoSchema.parse(await this.get('/account'));
      if (gen !== this.generation) return;
      this.account = acc;
      this.emit('account', acc);
    } catch (e) {
      if (gen !== this.generation) return;
      console.error('[bridge] account poll failed:', e instanceof Error ? e.message : e);
      if (this.account) {
        this.account = null;
        this.emit('account', null);
      }
    }
  }

  /** Raw call to the local bridge. Network failures throw (the caller must treat a thrown POST as "unknown"). */
  async http(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: { 'X-Aurum-Token': this.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  async candles(tf: Timeframe, count: number): Promise<Candle[]> {
    if (isVirtualTimeframe(tf)) {
      // MT5 has no such period: build it from the real candles of the base period (never from anything else).
      const { base, ratio } = VIRTUAL_TIMEFRAMES[tf];
      const need = Math.min(5000, (count + 1) * ratio);
      return aggregateCandles(await this.candles(base, need), tf).slice(-count);
    }
    const data = CandlesResponseSchema.parse(await this.get(`/candles?tf=${tf}&count=${count}`));
    return data.candles;
  }

  async symbolSpec(): Promise<SymbolSpec> {
    return SymbolSpecSchema.parse(await this.get('/symbol'));
  }

  async findSymbols(query: string): Promise<string[]> {
    const d = (await this.get(`/symbols?q=${encodeURIComponent(query)}`)) as { symbols?: string[] };
    return d.symbols ?? [];
  }

  /** Raw related-market quotes from MT5 (validated by the connector in core). */
  async quotes(symbols: string[]): Promise<unknown> {
    return this.get(`/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
  }
}
