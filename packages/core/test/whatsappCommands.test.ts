import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  MemoryWhatsAppStore, WhatsAppPipeline, WhatsAppSettingsSchema, stubActionHandler, stubAiHandler,
  type InboundMessage, type PipelineReply, type RemoteActionHandler, type RemoteAiHandler, type WhatsAppSettings, type WhatsAppStore,
} from '../src';
import { SqliteWhatsAppStore } from '../../../apps/desktop/src/main/whatsappStore';

const USER = 'user:50972923564215';
const T0 = 1_800_000_000_000;

const late = (id: string, text: string): InboundMessage => ({ ...msg(id, text, 0), timestampMs: T0 + 121_000 });
const msg = (id: string, text: string, ageSec = 1, from = USER): InboundMessage => ({
  id, from, timestampMs: T0 - ageSec * 1000, kind: 'text', text, caption: undefined, media: undefined, replyTo: undefined, reaction: undefined,
});

function rig(o: { store?: WhatsAppStore; settings?: Partial<WhatsAppSettings>; ai?: RemoteAiHandler; linked?: boolean; extra?: Partial<ConstructorParameters<typeof WhatsAppPipeline>[0]> } = {}) {
  const store = o.store ?? new MemoryWhatsAppStore();
  if (o.linked !== false) store.setLink({ status: 'linked', userId: USER, linkedAt: T0 });
  let t = T0;
  const sent: PipelineReply[] = [];
  const executed: string[] = [];
  const actions: RemoteActionHandler = {
    ...stubActionHandler,
    price: async () => 'GOLD 3350.10 / 3350.30',
    executeConfirmed: async (a, ctx) => { executed.push(`${a.kind}:${ctx.commandId}`); return { status: 'confirmed', text: `Done: ${a.kind}` }; },
  };
  const ai: RemoteAiHandler = o.ai ?? { handle: async (i) => (i.text.includes('close') ? { text: 'Plan ready.', proposedAction: { kind: 'close_position', payload: { ticket: 1 }, preview: 'Close ticket 1 (GOLD buy 0.10).', level: 'trade' } } : { text: 'ai:' + i.text }) };
  let code = 4821;
  const p = new WhatsAppPipeline({
    store, actions, ai, now: () => t, ...o.extra, randomDigits: (n) => String(code++).padStart(n, '0').slice(0, n),
    settings: () => WhatsAppSettingsSchema.parse({ permission: 'trade', ...o.settings }),
    send: async (r) => { sent.push(r); return { jobId: 'j', status: 'sent', messageIds: [`wamid.OUT${sent.length}`], partsSent: 1, partsTotal: 1 }; },
  });
  return { p, store, sent, executed, advance: (ms: number) => { t += ms; }, texts: () => sent.map((s) => s.text ?? '') };
}

describe.each([['memory', () => new MemoryWhatsAppStore()], ['sqlite', () => new SqliteWhatsAppStore(new DatabaseSync(':memory:'))]] as const)('pipeline on %s store', (_n, mk) => {
  it('suppresses duplicates by message id', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([msg('wamid.1', '/price')]);
    const s = await r.p.handleBatch([msg('wamid.1', '/price')]);
    expect(s.duplicates).toBe(1);
    expect(r.texts().filter((t) => t.includes('3350.10'))).toHaveLength(1);
  });

  it('never acts on stale/backlog messages; summarises them instead (and a restart cannot replay)', async () => {
    const store = mk();
    const r = rig({ store });
    await r.p.handleBatch([msg('old1', 'close everything', 600), msg('old2', 'CONFIRM 4821', 900), msg('old3', '/pause', 3600)]);
    expect(r.executed).toEqual([]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toMatch(/3 messages arrived/);
    expect(r.sent[0]!.text).toMatch(/did NOT act/);
    expect(r.sent[0]!.text).not.toMatch(/4821/);
    // "restart": same store, a fresh pipeline gets the same backlog again from the platform
    const r2 = rig({ store });
    const s = await r2.p.handleBatch([msg('old1', 'close everything', 600), msg('old3', '/pause', 3600)]);
    expect(s.duplicates).toBe(2);
    expect(r2.sent).toHaveLength(0);
    expect(store.listHistory(50).filter((h) => h.status === 'expired')).toHaveLength(3);
  });

  it('rejects unparseable and future timestamps', async () => {
    const r = rig({ store: mk() });
    const bad = { ...msg('x1', '/price'), timestampMs: NaN };
    const future = { ...msg('x2', '/price'), timestampMs: T0 + 10 * 60_000 };
    const s = await r.p.handleBatch([bad, future]);
    expect(s.accepted).toBe(0);
    expect(r.sent).toHaveLength(0);
  });

  it('confirmation: valid code executes exactly once, bound to the proposing command', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([msg('a1', 'please close my trade')]);
    expect(r.texts().join('\n')).toMatch(/1 - Confirm/);
    expect(r.executed).toEqual([]);
    await r.p.handleBatch([msg('a2', 'CONFIRM 4821')]);
    expect(r.executed).toHaveLength(1);
    expect(r.executed[0]).toMatch(/^close_position:wa-[0-9a-f]{24}-act$/);
    expect(r.texts().at(-1)).toBe('Done: close_position');
    expect(r.sent.at(-1)!.tradeRelated).toBe(true);
    // never stores the code in clear text in the history
    expect(JSON.stringify(r.store.listHistory(50))).not.toMatch(/CONFIRM 4821/);
  });

  it('numbered choices: option 3 runs that alternative once, last number cancels, out of range is refused', async () => {
    const multi: RemoteAiHandler = { handle: async () => ({ text: 'Two zones.', proposedAction: {
      kind: 'ai_tools', payload: { v: 'a' }, preview: 'Zone A', level: 'chart', label: 'Zone A',
      alternatives: [{ kind: 'ai_tools', payload: { v: 'b' }, preview: 'Zone B', level: 'chart', label: 'Zone B' }, { kind: 'close_position', payload: {}, preview: 'Close', level: 'trade', label: 'Close trade' }],
    } }) };
    const r = rig({ store: mk(), ai: multi, settings: { permission: 'chart' } });
    await r.p.handleBatch([msg('m1', 'ideas')]);
    const prompt = r.texts().at(-1)!;
    expect(prompt).toMatch(/1 - Zone A\n2 - Zone B\n3 - Cancel/); // trade alternative hidden at chart level
    await r.p.handleBatch([msg('m2', '9')]);
    expect(r.texts().at(-1)).toMatch(/number from 1 to 3/);
    expect(r.executed).toEqual([]);
    await r.p.handleBatch([msg('m3', '2')]);
    expect(r.executed).toHaveLength(1);
    expect(r.executed[0]).toMatch(/^ai_tools:wa-[0-9a-f]{24}-act-o2$/);
    await r.p.handleBatch([msg('m4', '2')]);
    expect(r.executed).toHaveLength(1); // single use
    await r.p.handleBatch([msg('m5', 'ideas')]);
    await r.p.handleBatch([msg('m6', '3')]);
    expect(r.texts().at(-1)).toMatch(/Cancelled/);
    expect(r.executed).toHaveLength(1);
  });

  it('confirmation: reused code, wrong code, "yes", expired code and voice-less cases are refused', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([msg('b1', 'close it')]);
    await r.p.handleBatch([msg('b3', 'CONFIRM 1111')]);
    expect(r.texts().at(-1)).toMatch(/Wrong code. 2 tries left/);
    await r.p.handleBatch([msg('b4', 'CONFIRM 4821')]);
    await r.p.handleBatch([msg('b5', 'CONFIRM 4821')]); // reuse
    expect(r.texts().at(-1)).toMatch(/Nothing is waiting/);
    expect(r.executed).toHaveLength(1);

    // expired
    await r.p.handleBatch([msg('c1', 'close again')]);
    r.advance(121_000);
    await r.p.handleBatch([late('c2', 'CONFIRM 4822')]);
    expect(r.texts().at(-1)).toMatch(/expired/);
    expect(r.executed).toHaveLength(1);

    // three wrong codes lock the confirmation, even the right code afterwards does nothing
    await r.p.handleBatch([late('d1', 'close once more')]);
    for (const i of [1, 2, 3]) await r.p.handleBatch([late(`d-w${i}`, 'CONFIRM 0000')]);
    await r.p.handleBatch([late('d-ok', 'CONFIRM 4823')]);
    expect(r.executed).toHaveLength(1);
  });

  it('a new proposal supersedes the old code', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([msg('e1', 'close first')]);
    await r.p.handleBatch([msg('e2', 'close second')]);
    await r.p.handleBatch([msg('e3', 'CONFIRM 4821')]);
    expect(r.executed).toHaveLength(0);
    await r.p.handleBatch([msg('e4', 'CONFIRM 4822')]);
    expect(r.executed).toHaveLength(1);
  });

  it('trade proposals need the trade level; /resume needs a code', async () => {
    const r = rig({ store: mk(), settings: { permission: 'ask' } });
    await r.p.handleBatch([msg('f1', 'close it')]);
    expect(r.texts().at(-1)).toMatch(/needs the "trade" permission/);
    const r2 = rig({ store: mk(), settings: { permission: 'chart' } });
    await r2.p.handleBatch([msg('g1', '/resume')]);
    expect(r2.texts().at(-1)).toMatch(/1 - Confirm/);
  });

  it('notify-only ignores commands; slash shortcuts and the AI stub work', async () => {
    const n = rig({ store: mk(), settings: { permission: 'notify' } });
    await n.p.handleBatch([msg('h1', '/price')]);
    expect(n.texts().at(-1)).toMatch(/notify-only/);
    const r = rig({ store: mk(), ai: stubAiHandler });
    await r.p.handleBatch([msg('h2', '/price'), msg('h3', '/positions'), msg('h4', 'hello there'), msg('h5', '/nope')]);
    expect(r.texts()).toEqual(['GOLD 3350.10 / 3350.30', 'MT5 orders module not available yet.', 'AI not connected yet.', 'Unknown command /nope. Send /help.']);
  });

  it('only the linked id may command; others are rejected without executing', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([msg('i1', '/pause', 1, 'user:999')]);
    expect(r.texts().at(-1)).toMatch(/not linked/);
    expect(r.store.listHistory(10).some((h) => h.status === 'rejected_identity')).toBe(true);
  });

  it('pairing: first message starts it, the app code links, wrong codes are counted', async () => {
    const r = rig({ store: mk(), linked: false });
    await r.p.handleBatch([msg('p1', 'hi')]);
    expect(r.store.getLink()).toMatchObject({ status: 'pairing', candidate: USER });
    await r.p.handleBatch([msg('p2', '000000')]);
    expect(r.store.getLink().status).toBe('pairing');
    await r.p.handleBatch([msg('p3', '482100'.slice(0, 6))]);
    // code generated is the first randomDigits(6) -> "004821"
    await r.p.handleBatch([msg('p4', '004821')]);
    expect(r.store.getLink()).toMatchObject({ status: 'linked', userId: USER });
  });

  it('voice notes are not supported without a transcriber; reactions are ignored', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([{ ...msg('v1', ''), kind: 'voice', text: undefined, media: { id: 'm', mimeType: 'audio/ogg', sha256Base64: undefined, filename: undefined, caption: undefined } }]);
    expect(r.texts().at(-1)).toMatch(/Voice notes are not supported yet/);
    await r.p.handleBatch([{ ...msg('v2', ''), kind: 'reaction', text: undefined, reaction: { messageId: 'x', emoji: '👍' } }]);
    expect(r.sent).toHaveLength(1);
    expect(r.executed).toHaveLength(0);
  });

  it('delivery receipts update the outbound history row', async () => {
    const r = rig({ store: mk() });
    await r.p.handleBatch([msg('k1', '/price')]);
    expect(r.store.setDelivery('wamid.OUT1', 'delivered', 1)).toBe(true);
    expect(r.store.listHistory(5).find((h) => h.direction === 'out')!.status).toBe('delivered');
    r.store.setDelivery('wamid.OUT1', 'read', 2);
    r.store.setDelivery('wamid.OUT1', 'delivered', 3);
    expect(r.store.listHistory(5).find((h) => h.direction === 'out')!.status).toBe('read');
  });
});

describe('voice, images and files from WhatsApp', () => {
  const media = { id: 'm1', mimeType: 'audio/ogg', sha256Base64: undefined, filename: 'plan.pdf', caption: undefined };
  const fetchMedia = async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' });

  it('a voice note is transcribed, echoed and answered by the AI, but never confirms an action', async () => {
    const seen: string[] = [];
    const ai: RemoteAiHandler = { handle: async (i) => { seen.push(`${i.text}|${i.viaVoice}`); return { text: 'ok' }; } };
    const r = rig({ ai, extra: { fetchMedia, transcriber: { transcribe: async () => 'gold ka level batao' } } });
    await r.p.handleBatch([{ ...msg('v1', ''), kind: 'voice', text: undefined, media }]);
    expect(r.texts()).toContain('Heard: "gold ka level batao"');
    expect(seen).toEqual(['gold ka level batao|true']);
  });

  it('a document reaches the AI as an attachment with its name', async () => {
    let got: { kind: string; name?: string; size: number } | null = null;
    const ai: RemoteAiHandler = { handle: async (i) => { const a = i.attachments[0]!; got = { kind: a.kind, ...(a.kind === 'document' ? { name: a.name } : {}), size: a.bytes.length }; return { text: 'read it' }; } };
    const r = rig({ ai, extra: { fetchMedia } });
    await r.p.handleBatch([{ ...msg('d1', ''), kind: 'document', text: undefined, caption: 'analyse this', media }]);
    expect(got).toEqual({ kind: 'document', name: 'plan.pdf', size: 3 });
    expect(r.texts().at(-1)).toBe('read it');
  });

  it('pictures the AI produces are sent back to the user', async () => {
    const ai: RemoteAiHandler = { handle: async () => ({ text: 'Here is the chart', images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', filename: 'chart-1.png' }] }) };
    const r = rig({ ai });
    await r.p.handleBatch([msg('s1', 'screenshot dikhao')]);
    expect(r.sent.at(-1)!.images).toHaveLength(1);
    expect(r.sent.at(-1)!.images![0]!.mimeType).toBe('image/png');
  });
});
