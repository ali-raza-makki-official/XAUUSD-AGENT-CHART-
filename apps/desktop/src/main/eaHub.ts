import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Receives the optional MQL5 EA (bridge/mql5/AurumBridge.mq5) over a loopback WebSocket and re-exposes it through the SAME
 * local HTTP interface as the Python bridge, so BridgeManager, OrderService, alerts and the chart need no changes.
 * Protocol: docs/MQL5_BRIDGE.md. Loopback only, token on both sides.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;

class WsConn {
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];
  constructor(private readonly socket: Duplex, private readonly onText: (s: string) => void, private readonly onClose: () => void) {
    socket.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', onClose);
    socket.on('error', () => socket.destroy());
  }
  private parse(): void {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0, op = b[0]! & 0x0f, masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f, pos = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); pos = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); pos = 10; }
      if (len > MAX_FRAME) { this.socket.destroy(); return; }
      if (masked) pos += 4;
      if (b.length < pos + len) return;
      const payload = Buffer.from(b.subarray(pos, pos + len));
      if (masked) for (let i = 0; i < len; i++) payload[i]! ^= b[pos - 4 + (i & 3)]!;
      this.buf = b.subarray(pos + len);
      if (op === 0x8) { this.socket.end(); return; }
      if (op === 0x9) { this.send(payload, 0xa); continue; }
      if (op === 0x1 || op === 0x0) {
        this.frag.push(payload);
        if (fin) { const s = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.onText(s); }
      }
    }
  }
  send(data: Buffer | string, op = 0x1): void {
    const p = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const h = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : p.length <= 65535 ? Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x80 | op; x[1] = 127; x.writeBigUInt64BE(BigInt(p.length), 2); return x; })();
    if (!this.socket.destroyed) this.socket.write(Buffer.concat([h, p]));
  }
  close(): void { this.socket.destroy(); }
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } // eslint-disable-line @typescript-eslint/no-explicit-any
interface Tick { bid: number; ask: number; time: number }

export class EaHub {
  readonly eaToken = randomBytes(18).toString('hex');
  readonly httpToken = randomBytes(24).toString('hex');
  eaPort = 0;
  httpPort = 0;
  private wsServer: Server | null = null;
  private httpServer: Server | null = null;
  private conn: WsConn | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private symbol = 'GOLD';
  private tradingEnabled = false;
  private tick: Tick | null = null;
  private account: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  private info: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  private positions: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  private point = 0;

  constructor(private readonly preferredEaPort = 8766, token?: string) { if (token) (this as { eaToken: string }).eaToken = token; }

  get connected(): boolean { return !!this.conn && !!this.info; }
  config(symbol: string, tradingEnabled: boolean): void {
    this.symbol = symbol;
    this.tradingEnabled = tradingEnabled;
    if (this.connected) this.conn!.send(JSON.stringify({ action: 'subscribe', symbols: [symbol] }));
  }

  async start(): Promise<void> {
    if (this.wsServer) return;
    this.wsServer = createServer((_req, res) => { res.writeHead(426); res.end('WebSocket only'); });
    this.wsServer.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
    await new Promise<void>((resolve, reject) => { this.wsServer!.once('error', reject); this.wsServer!.listen(this.preferredEaPort, '127.0.0.1', resolve); });
    this.eaPort = (this.wsServer.address() as { port: number }).port;
    this.httpServer = createServer((req, res) => void this.onHttp(req, res));
    await new Promise<void>((resolve) => this.httpServer!.listen(0, '127.0.0.1', resolve));
    this.httpPort = (this.httpServer.address() as { port: number }).port;
  }
  stop(): void { this.conn?.close(); this.wsServer?.close(); this.httpServer?.close(); this.wsServer = this.httpServer = null; this.conn = null; }

  // ---- EA side ----
  private onUpgrade(req: IncomingMessage, socket: Duplex): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let registered = false;
    const ws: WsConn = new WsConn(socket, (text) => {
      let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { m = JSON.parse(text); } catch { return; }
      if (!registered) {
        const a = Buffer.from(String(m.token ?? '')), b = Buffer.from(this.eaToken);
        const ok = m.action === 'register' && m.protocol === 1 && a.length === b.length && timingSafeEqual(a, b);
        ws.send(JSON.stringify({ action: 'registered', ok, ...(ok ? {} : { error: 'bad token or protocol' }) }));
        if (!ok) { setTimeout(() => ws.close(), 100); return; }
        registered = true;
        this.conn?.close();
        this.conn = ws;
        this.info = m;
        this.tick = null; this.positions = [];
        ws.send(JSON.stringify({ action: 'subscribe', symbols: [this.symbol] }));
        ws.send(JSON.stringify({ action: 'positions' }));
        return;
      }
      this.onEaMessage(m);
    }, () => { if (this.conn === ws) { this.conn = null; this.info = null; this.rejectAll('The EA disconnected.'); } });
  }

  private onEaMessage(m: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (m.action) {
      case 'ticks': for (const t of m.t ?? []) if (t[0] === this.symbol) this.tick = { bid: t[1], ask: t[2], time: t[3] / 1000 }; return;
      case 'account': this.account = m; return;
      case 'positions': this.positions = m.list ?? []; return;
      case 'pong': return;
      default: {
        const p = m.req_id ? this.pending.get(String(m.req_id)) : undefined;
        if (p) { clearTimeout(p.timer); this.pending.delete(String(m.req_id)); p.resolve(m); }
      }
    }
  }
  private rejectAll(why: string): void { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id); } }
  private request(msg: Record<string, unknown>, timeoutMs = 15000): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!this.conn) return Promise.reject(new Error('The MT5 EA is not connected. Attach AurumBridge to a chart in MT5.'));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The EA did not answer in time.')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.conn!.send(JSON.stringify({ ...msg, req_id: id }));
    });
  }

  // ---- app side: the same HTTP shape as the Python bridge ----
  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => { const s = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
    const supplied = Buffer.from(String(req.headers['x-aurum-token'] ?? '')), want = Buffer.from(this.httpToken);
    if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const q = url.searchParams;
    try {
      let body: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (req.method === 'POST') { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      const need = () => { if (!this.connected) throw new HttpErr(503, 'The MT5 EA is not connected. Open MT5 and attach AurumBridge to a chart (see docs/MQL5_BRIDGE.md).'); };
      switch (url.pathname) {
        case '/health': return send(200, { ok: true, connected: this.connected, symbol: this.symbol, error: this.connected ? null : 'EA not connected', version: 'ea-0.1' });
        case '/tick': need(); if (!this.tick) throw new HttpErr(503, `No tick yet for ${this.symbol}.`); return send(200, { symbol: this.symbol, bid: this.tick.bid, ask: this.tick.ask, time: this.tick.time, spread: Number((this.tick.ask - this.tick.bid).toFixed(10)) });
        case '/account': { need(); const a = this.account ?? {}; const i = this.info ?? {}; return send(200, { login: i.account_number ?? null, server: i.server ?? '', currency: a.currency ?? i.currency ?? 'USD', demo: !!(a.demo ?? i.demo), name: null, balance: a.balance, equity: a.equity }); }
        case '/candles': { need(); const r = await this.request({ action: 'candles', symbol: this.symbol, tf: q.get('tf') ?? 'M15', count: Number(q.get('count') ?? 500) }); if (!r.ok) throw new HttpErr(503, r.error); return send(200, { symbol: this.symbol, tf: q.get('tf') ?? 'M15', candles: r.data.map((c: number[]) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] })) }); }
        case '/symbol': { need(); const r = await this.request({ action: 'spec', symbol: this.symbol }); if (!r.ok) throw new HttpErr(503, r.error); this.point = r.point; return send(200, r); }
        case '/symbols': { need(); const found = new Set<string>(); for (const n of (q.get('q') ?? 'XAU,GOLD').split(',')) { const r = await this.request({ action: 'symbols', q: n }); for (const s of r.list ?? []) found.add(s); } return send(200, { symbols: [...found].sort().slice(0, 50) }); }
        case '/positions': need(); return send(200, { positions: this.positions });
        case '/orders': need(); return send(200, { orders: [] }); // the EA does not report pending orders yet
        case '/deals': { need(); const r = await this.request({ action: 'deals', since: Number(q.get('since') ?? 0) || undefined }); if (!r.ok) throw new HttpErr(503, r.error); return send(200, { deals: (r.list ?? []).map((d: object) => ({ reason: 'unknown', ...d })) }); }
        case '/trade/status': return send(200, { enabled: this.tradingEnabled, provider: 'ea', connected: this.connected });
        case '/trade/find': {
          need();
          const r = await this.request({ action: 'find', command_id: q.get('commandId') });
          const ticket = r.found ? Number(r.ticket) : null;
          const pos = ticket ? this.positions.find((p) => p.ticket === ticket) ?? null : null;
          return send(200, { tag: r.tag, queried: { positions: true, orders: false, deals: true, historyOrders: false }, positions: pos ? [pos] : [], orders: [], deals: [], historyOrders: [], target: r.found ? { ticket, position: pos, order: null, deals: [] } : null });
        }
      }
      if (url.pathname.startsWith('/trade/') && req.method === 'POST') {
        if (!this.tradingEnabled) throw new HttpErr(403, 'Trading is disabled in Aurum Settings.', 'trading_disabled');
        need();
        const action = url.pathname.slice('/trade/'.length);
        const dev = body.deviationPoints && this.point ? body.deviationPoints * this.point : undefined;
        const map: Record<string, Record<string, unknown> | null> = {
          open_market: { action: 'open', command_id: body.commandId, symbol: body.symbol, side: body.side, volume: body.volume, sl: body.sl ?? 0, tp: body.tp ?? 0, ...(dev ? { deviation: dev } : {}) },
          modify_sltp: { action: 'modify', ticket: body.ticket, ...(body.sl !== undefined ? { sl: body.sl ?? 0 } : {}), ...(body.tp !== undefined ? { tp: body.tp ?? 0 } : {}) },
          close_position: { action: 'close', command_id: body.commandId, ticket: body.ticket },
          partial_close: { action: 'close', command_id: body.commandId, ticket: body.ticket, volume: body.volume },
        };
        const msg = map[action];
        if (!msg) throw new HttpErr(400, `'${action}' is not supported by the EA bridge yet. Use the Python bridge for pending orders.`, 'unsupported');
        const r = await this.request(msg, 45000).catch((e) => { throw new HttpErr(504, `No answer from the EA: ${e.message}. The order may or may not have been sent. Check MT5.`, 'unknown'); });
        return send(200, { status: r.status, retcode: r.retcode ?? null, message: r.message, positionTicket: r.ticket ?? null, order: null, deal: null, volume: r.volume ?? null, price: r.price ?? null, ...(r.duplicate ? { duplicate: true } : {}) });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpErr) return send(e.status, { error: e.message, code: e.code });
      return send(503, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

class HttpErr extends Error { constructor(readonly status: number, message: string, readonly code = 'ea') { super(message); } }
