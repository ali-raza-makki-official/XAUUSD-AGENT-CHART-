import { afterEach, describe, expect, it } from 'vitest';
import { BrokerNotSent } from '@aurum/core';
import { EaHub } from './eaHub';
import { bridgePort } from './orders';
import type { BridgeManager } from './bridge';

const TOKEN = 'ea-token-0123456789';
let hub: EaHub | null = null;
afterEach(() => { hub?.stop(); hub = null; });

/** A stand-in EA over a real WebSocket. `onMsg` returns the reply, or 'drop' to close the socket without answering. */
async function connectEa(h: EaHub, onMsg: (m: any) => object | 'drop' | null): Promise<WebSocket> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ws = new WebSocket(`ws://127.0.0.1:${h.eaPort}`);
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('ws error')); });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.action === 'registered' || m.action === 'subscribe') return;
    const reply = onMsg(m);
    if (reply === 'drop') ws.close();
    else if (reply) ws.send(JSON.stringify({ req_id: m.req_id, ...reply }));
  };
  ws.send(JSON.stringify({ action: 'register', protocol: 1, token: TOKEN, account_number: 1, server: 'demo', demo: true }));
  const t0 = Date.now();
  while (!h.connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  return ws;
}
const port = (h: EaHub) => bridgePort({
  http: async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${h.httpPort}${path}`, { method, headers: { 'x-aurum-token': h.httpToken, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  },
  lastTick: null, status: { state: 'connected' }, tickAgeMs: () => 0,
} as unknown as BridgeManager);
const openBody = { commandId: 'cmd-0123456789', symbol: 'GOLD', side: 'buy', volume: 0.01, sl: 2600, tp: 0, deviationPoints: 20 };

describe('EA hub <-> order adapter contract', () => {
  it('a lost answer after the order reached the EA is "unknown", never "not sent"', async () => {
    hub = new EaHub(0, TOKEN); await hub.start(); hub.config('GOLD', true);
    await connectEa(hub, (m) => (m.action === 'open' ? 'drop' : null));
    const err = await port(hub).execute('open_market', openBody).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BrokerNotSent);
  });
  it('a refusal before anything was sent (trading disabled in the app) IS "not sent"', async () => {
    hub = new EaHub(0, TOKEN); await hub.start(); hub.config('GOLD', false);
    await connectEa(hub, () => null);
    const err = await port(hub).execute('open_market', openBody).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerNotSent);
  });
  it('evidence is complete enough to confirm an executed order from its tagged deal', async () => {
    hub = new EaHub(0, TOKEN); await hub.start(); hub.config('GOLD', true);
    await connectEa(hub, (m) => {
      if (m.action === 'find') return { ok: true, tag: 'AUR-x', found: true, where: 'deal', ticket: 55 };
      if (m.action === 'orders') return { ok: true, list: [] };
      if (m.action === 'deals') return { ok: true, list: [{ ticket: 9, order: 9, time: 1, type: 'buy', entry: 'in', positionId: 55, volume: 0.01, price: 2650, commission: 0, swap: 0, profit: 0, fee: 0, symbol: 'GOLD', magic: 1, comment: 'AUR-x' }] };
      return null;
    });
    const ev = await port(hub).find('cmd-0123456789', null);
    expect(ev.queried).toMatchObject({ positions: true, orders: true, deals: true });
    expect(ev.deals).toHaveLength(1);
  });
});
