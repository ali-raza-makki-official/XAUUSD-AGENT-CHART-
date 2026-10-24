import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  AccountInfoSchema,
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

function bridgeDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'bridge');
  return app.isPackaged && existsSync(packaged) ? packaged : join(app.getAppPath(), '..', '..', 'bridge');
}

/** Packaged: the PyInstaller-frozen exe in resources/bridge (no Python needed). Dev: python -m aurum_bridge. */
function bridgeCommand(): { cmd: string; args: string[]; label: string } {
  if (app.isPackaged) {
    const exe = join(bridgeDir(), process.platform === 'win32' ? 'aurum-bridge.exe' : 'aurum-bridge');
    return { cmd: exe, args: [], label: 'bundled bridge' };
  }
  const python = process.env.AURUM_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  return { cmd: python, args: ['-m', 'aurum_bridge'], label: `Python (${python}). Install Python 3 or set AURUM_PYTHON` };
}

interface BridgeEvents {
  tick: [Tick];
  status: [FeedStatus];
  account: [AccountInfo | null];
}

/** Starts the Python MT5 bridge, polls it, and reports real feed state. Never produces data itself. */
export class BridgeManager extends EventEmitter<BridgeEvents> {
  private proc: ChildProcess | null = null;
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

  async start(brokerSymbol: string, mt5Path = ''): Promise<void> {
    await this.stop();
    const gen = ++this.generation;
    this.setStatus({ state: 'starting', message: 'Starting MT5 bridge…' });
    this.port = await freePort();
    this.token = randomBytes(24).toString('hex'); // per-launch secret, never exposed to the renderer
    const { cmd, args, label } = bridgeCommand();
    const proc = spawn(cmd, args, {
      cwd: bridgeDir(),
      env: {
        ...process.env,
        AURUM_TOKEN: this.token,
        AURUM_PORT: String(this.port),
        AURUM_SYMBOL: brokerSymbol,
        ...(mt5Path ? { AURUM_MT5_PATH: mt5Path } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-500)));
    proc.on('error', (e) => {
      if (gen === this.generation) {
        this.setStatus({ state: 'error', message: `Cannot start ${label}: ${e.message}.` });
      }
    });
    proc.on('exit', (code) => {
      if (gen === this.generation && this.proc === proc) {
        this.setStatus({ state: 'error', message: `MT5 bridge stopped (code ${code}). ${stderr.trim()}` });
      }
    });
    this.timer = setInterval(() => void this.pollTick(gen), TICK_POLL_MS);
    this.accountTimer = setInterval(() => void this.pollAccount(gen), ACCOUNT_POLL_MS);
    void this.pollAccount(gen);
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.accountTimer) clearInterval(this.accountTimer);
    this.timer = this.accountTimer = null;
    const p = this.proc;
    this.proc = null;
    if (p && !p.killed) p.kill();
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

  async candles(tf: Timeframe, count: number): Promise<Candle[]> {
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
