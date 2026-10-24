import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

/**
 * TEST-ONLY mock of the WhatsApp Agent Platform HTTP API, following the wire format in the developer manual.
 * It is never imported by product code. Nothing here proves the real service behaves the same way.
 */
export interface MockRequest { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: Buffer; json: any }
export interface Forced { status: number; body?: unknown; rawBody?: string; destroy?: boolean; delayMs?: number }

export const CREATOR = 'user:50972923564215';
const err = (status: number, code: number, message: string, details?: string): Forced => ({ status, body: { error: { message, type: 'OAuthException', code, ...(details ? { error_data: { messaging_product: 'whatsapp', details } } : {}), fbtrace_id: 'AW7bq' } } });
export const errors = {
  badToken: () => err(400, 100, '(#100) Invalid token'),
  noAuth: () => err(401, 190, '(#190) Missing authorization'),
  replaced: () => err(409, 1752041, '(#1752041) A newer poll replaced this one'),
  tooMany: (code = 130429) => err(429, code, '(#130429) Too many requests'),
  server: () => err(500, 2, '(#2) Internal error'),
  notAccepted: () => err(503, 131016, '(#131016) Not accepted for delivery'),
};

interface LogEntry { seq: bigint; kind: 'message' | 'status'; payload: any }

export class MockWhatsApp {
  server!: Server;
  baseUrl = '';
  token = 'test-token-SECRET-123';
  requests: MockRequest[] = [];
  sent: any[] = [];
  statuses: any[] = [];
  deleted: string[] = [];
  media = new Map<string, { bytes: Buffer; mime: string; hexOverride?: string }>();
  /** Raw first sequence number. Large on purpose so tests prove 64-bit offsets survive. */
  nextSeq = 9223372036854770000n;
  private log: LogEntry[] = [];
  private forced = new Map<string, Forced[]>();
  holdMs = 25;
  /** Real-time rolling limit; tests with a fake clock turn this off. */
  enforceRate = true;
  private counter = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/agent/v1`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Force the next response(s) for a route like 'GET /updates' or 'POST /messages'. */
  force(route: string, ...responses: Forced[]): void { this.forced.set(route, [...(this.forced.get(route) ?? []), ...responses]); }
  count(route: string): number { return this.requests.filter((r) => `${r.method} ${r.path}` === route).length; }
  reqs(route: string): MockRequest[] { return this.requests.filter((r) => `${r.method} ${r.path}` === route); }

  wamid = () => `wamid.IN${++this.counter}`;
  pushText(text: string, o: { from?: string; id?: string; ageSec?: number } = {}): string {
    const id = o.id ?? this.wamid();
    return this.pushMessage({ from: o.from ?? CREATOR, id, timestamp: String(Math.floor(Date.now() / 1000) - (o.ageSec ?? 0)), type: 'text', text: { body: text } }, id);
  }
  pushMessage(m: any, id: string): string { this.log.push({ seq: this.nextSeq++, kind: 'message', payload: m }); return id; }
  pushStatus(id: string, status: 'delivered' | 'read'): void { this.log.push({ seq: this.nextSeq++, kind: 'status', payload: { id, status, recipient_id: CREATOR, timestamp: String(Math.floor(Date.now() / 1000)) } }); }

  private reply(res: ServerResponse, f: Forced): void {
    if (f.destroy) { res.socket?.destroy(); return; }
    const send = () => { res.statusCode = f.status; res.setHeader('Content-Type', 'application/json'); res.end(f.rawBody ?? (f.body === undefined ? '' : JSON.stringify(f.body))); };
    if (f.delayMs) setTimeout(send, f.delayMs); else send();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/agent\/v1/, '');
    let json: any;
    try { json = JSON.parse(body.toString('utf8')); } catch { /* multipart or empty */ }
    this.requests.push({ method: req.method ?? '', path, query: url.searchParams, headers: req.headers, body, json });
    const route = `${req.method} ${path.replace(/^(\/media\/[^/]+)(\/content)?$/, (_m, a, b) => (b ? '/media/:id/content' : '/media/:id'))}`;

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return this.reply(res, errors.noAuth());
    if (auth !== `Bearer ${this.token}`) return this.reply(res, errors.badToken());

    const queued = this.forced.get(route);
    if (queued?.length) return this.reply(res, queued.shift()!);

    if (route === 'GET /updates') return this.updates(url, res);
    if (route === 'POST /messages') return this.postMessage(json, res);
    if (route === 'POST /statuses') {
      if (!json?.message_id || json.status !== 'read') return this.reply(res, err(400, 131009, '(#131009) bad', 'Field "message_id" must be a wamid issued by this platform'));
      this.statuses.push(json);
      return this.reply(res, { status: 200, body: { success: true } });
    }
    if (route === 'POST /media') return this.upload(req, body, res);
    if (route === 'GET /media/:id') {
      const id = decodeURIComponent(path.split('/')[2] ?? '');
      const m = this.media.get(id);
      if (!m) return this.reply(res, err(400, 100, '(#100) unknown media id'));
      return this.reply(res, { status: 200, body: { url: `${this.baseUrl}/media/${id}/content`, mime_type: m.mime, sha256: m.hexOverride ?? createHash('sha256').update(m.bytes).digest('hex'), file_size: m.bytes.length, id, messaging_product: 'whatsapp' } });
    }
    if (route === 'GET /media/:id/content') {
      const m = this.media.get(decodeURIComponent(path.split('/')[2] ?? ''));
      if (!m) return this.reply(res, err(404, 100, '(#100) expired'));
      res.statusCode = 200; res.setHeader('Content-Type', m.mime); res.end(m.bytes); return;
    }
    if (route === 'DELETE /media/:id') { const id = decodeURIComponent(path.split('/')[2] ?? ''); this.deleted.push(id); this.media.delete(id); return this.reply(res, { status: 200, body: { success: true } }); }
    return this.reply(res, err(404, 100, 'no such route'));
  }

  private updates(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    const offRaw = q.get('offset');
    if (offRaw !== null && !/^-?\d+$/.test(offRaw)) return this.reply(res, err(400, 100, '(#100) bad offset'));
    const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 50) || 50));
    const head = this.nextSeq;
    const offset = offRaw === null ? head : BigInt(offRaw) < 0n ? 0n : BigInt(offRaw);
    const respond = () => {
      const entries = this.log.filter((e) => e.seq >= offset).slice(0, limit);
      if (!entries.length) { res.statusCode = 204; res.end(); return; }
      const messages = entries.filter((e) => e.kind === 'message').map((e) => e.payload);
      const statuses = entries.filter((e) => e.kind === 'status').map((e) => e.payload);
      const next = entries[entries.length - 1]!.seq + 1n;
      const contacts = [{ wa_id: CREATOR, profile: { name: 'Alex' } }];
      const text = JSON.stringify({ object: 'whatsapp_agent_platform', entry: [{ id: '123456789', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts, messages, statuses } }] }], next_offset: '__NEXT__' }).replace('"__NEXT__"', next.toString());
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(text);
    };
    const hasNow = this.log.some((e) => e.seq >= offset);
    if (hasNow) return respond();
    setTimeout(respond, this.holdMs); // long-poll stand-in (short on purpose)
  }

  private postMessage(j: any, res: ServerResponse): void {
    if (!j || j.messaging_product !== 'whatsapp' || typeof j.to !== 'string' || !/^user:\S+$/.test(j.to)) return this.reply(res, err(400, 131009, '(#131009) Missing or malformed required fields', 'Invalid participant format; expected "<type>:<int id>", where type = agent|user'));
    if (j.to !== CREATOR) return this.reply(res, err(403, 131005, '(#131005) Recipient is not the agent creator'));
    if (j.type === 'text' && (j.text?.body?.length ?? 0) > 4096) return this.reply(res, err(400, 100, 'text.body'));
    const recent = this.sent.filter((s) => Date.now() - s.at < 60_000).length;
    if (this.enforceRate && recent >= 12) return this.reply(res, errors.tooMany());
    this.sent.push({ ...j, at: Date.now() });
    const id = `wamid.OUT${this.sent.length}`;
    return this.reply(res, { status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: j.to, wa_id: j.to }], messages: [{ id }] } });
  }

  private async upload(req: IncomingMessage, body: Buffer, res: ServerResponse): Promise<void> {
    const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body: body as unknown as BodyInit }).formData();
    const file = form.get('file');
    if (form.get('messaging_product') !== 'whatsapp' || !(file instanceof File)) return this.reply(res, err(400, 131009, '(#131009) missing'));
    const id = `media-${this.media.size + 1}`;
    this.media.set(id, { bytes: Buffer.from(await file.arrayBuffer()), mime: String(form.get('type') ?? file.type) });
    return this.reply(res, { status: 200, body: { id } });
  }
}
