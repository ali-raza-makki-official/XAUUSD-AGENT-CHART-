import { describe, expect, it } from 'vitest';
import {
  AI_TOOLS, AiPermissionsSchema, DrawingStore, PROVIDERS, buildSystemPrompt, runAgent, runAiTool, toGeminiSchema, toolCatalog,
  type ChatMessage, type LlmRequest, type LlmResponse, type ToolContext,
} from '../src';

const tools = toolCatalog(AiPermissionsSchema.parse({ drawingsEdit: true }));
const req = (messages: ChatMessage[]): LlmRequest => ({ system: 'SYS', messages, tools, maxTokens: 1000 });
const convo: ChatMessage[] = [
  { role: 'user', blocks: [{ type: 'text', text: 'analyse' }] },
  { role: 'assistant', blocks: [{ type: 'text', text: 'checking' }, { type: 'tool_call', id: 'c1', name: 'get_chart_state', input: {} }] },
  { role: 'user', blocks: [{ type: 'tool_result', callId: 'c1', name: 'get_chart_state', content: '{"ok":true,"data":{"bid":3350}}' }] },
];
const cfg = { baseUrl: 'https://x.test/', model: 'm1', key: 'SECRET' };

describe('Anthropic adapter', () => {
  it('builds a Messages request with tool_use / tool_result blocks', () => {
    const r = PROVIDERS.anthropic.buildChat(cfg, req(convo));
    const b = JSON.parse(r.body!);
    expect(r.url).toBe('https://x.test/v1/messages');
    expect(r.headers['x-api-key']).toBe('SECRET');
    expect(b.system).toBe('SYS');
    expect(b.messages[1].content[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'get_chart_state' });
    expect(b.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
    expect(b.tools[0].input_schema.$schema).toBeUndefined();
    expect(r.body).not.toContain('SECRET');
  });
  it('parses text + tool_use and usage', () => {
    const out = PROVIDERS.anthropic.parseChat({ content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'get_candles', input: { count: 5 } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } });
    expect(out.stop).toBe('tool_use');
    expect(out.blocks[1]).toMatchObject({ type: 'tool_call', id: 't1', input: { count: 5 } });
    expect(out.usage).toEqual({ input: 10, output: 4 });
  });
  it('explains auth and rate-limit errors', () => {
    expect(PROVIDERS.anthropic.parseError(401, { error: { message: 'bad key' } })).toMatch(/rejected the API key/);
    expect(PROVIDERS.anthropic.parseError(429, {})).toMatch(/Rate limit/);
  });
  it('lists models', () => {
    expect(PROVIDERS.anthropic.parseModels({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
  });
});

describe.each(['openai', 'deepseek'] as const)('%s adapter (chat completions)', (id) => {
  const a = PROVIDERS[id];
  it('maps tool calls and results to assistant.tool_calls and role:tool messages', () => {
    const b = JSON.parse(a.buildChat(cfg, req(convo)).body!);
    expect(b.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(b.messages[2].tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'get_chart_state', arguments: '{}' } });
    expect(b.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(b.tools[0]).toMatchObject({ type: 'function' });
  });
  it('uses the right max-token parameter', () => {
    const b = JSON.parse(a.buildChat(cfg, req(convo)).body!);
    expect(id === 'openai' ? b.max_completion_tokens : b.max_tokens).toBe(1000);
  });
  it('parses tool calls with JSON-string arguments, and survives broken JSON', () => {
    const ok = a.parseChat({ choices: [{ message: { content: null, tool_calls: [{ id: 'k1', type: 'function', function: { name: 'get_candles', arguments: '{"count":3}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
    expect(ok.blocks[0]).toMatchObject({ type: 'tool_call', input: { count: 3 } });
    expect(ok.stop).toBe('tool_use');
    const bad = a.parseChat({ choices: [{ message: { tool_calls: [{ id: 'k2', function: { name: 'x', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] });
    expect((bad.blocks[0] as { input: object }).input).toHaveProperty('__invalid_json');
  });
});

describe('Gemini adapter', () => {
  const a = PROVIDERS.gemini;
  it('builds generateContent with functionCall / functionResponse parts and key in a header', () => {
    const r = a.buildChat({ ...cfg, model: 'gem-1' }, req(convo));
    const b = JSON.parse(r.body!);
    expect(r.url).toBe('https://x.test/v1beta/models/gem-1:generateContent');
    expect(r.headers['x-goog-api-key']).toBe('SECRET');
    expect(r.url).not.toContain('SECRET');
    expect(b.contents[1].role).toBe('model');
    expect(b.contents[1].parts[1].functionCall.name).toBe('get_chart_state');
    expect(b.contents[2].parts[0].functionResponse.name).toBe('get_chart_state');
    expect(b.contents[2].parts[0].functionResponse.response).toEqual({ ok: true, data: { bid: 3350 } });
  });
  it('removes schema keywords Gemini rejects', () => {
    const s = toGeminiSchema({ $schema: 'x', type: 'object', additionalProperties: false, properties: { a: { const: 'hline' }, b: { type: ['number', 'null'], default: 1 } }, required: ['a'] }) as any;
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBeUndefined();
    expect(s.properties.a).toMatchObject({ enum: ['hline'], type: 'string' });
    expect(s.properties.b).toMatchObject({ type: 'number', nullable: true });
    expect(s.properties.b.default).toBeUndefined();
  });
  it('the real tool catalog converts without leftover unsupported keys', () => {
    const json = JSON.stringify(tools.map((t) => toGeminiSchema(t.inputSchema)));
    for (const bad of ['additionalProperties', '$schema', '"const"', '"default"', '"$ref"']) expect(json).not.toContain(bad);
  });
  it('parses function calls and assigns ids', () => {
    const out = a.parseChat({ candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'get_candles', args: { count: 2 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } });
    expect(out.stop).toBe('tool_use');
    expect(out.blocks[1]).toMatchObject({ type: 'tool_call', name: 'get_candles', input: { count: 2 } });
    expect((out.blocks[1] as { id: string }).id).toMatch(/^call_/);
  });
  it('lists only models that support generateContent', () => {
    expect(a.parseModels({ models: [{ name: 'models/g1', supportedGenerationMethods: ['generateContent'] }, { name: 'models/emb', supportedGenerationMethods: ['embedContent'] }] })).toEqual(['g1']);
  });
});

function ctx(): ToolContext {
  return {
    store: new DrawingStore(), permissions: AiPermissionsSchema.parse({ drawingsEdit: true }),
    getState: () => ({ symbol: 'XAUUSD', brokerSymbol: 'GOLD', timeframe: 'M15', feed: 'MT5', bid: 3350, ask: 3350.2, spread: 0.2, tickTime: 1, account: null, selectedDrawingId: null, pipSize: 0.1 }),
    getCandles: async () => [], getSpec: () => null, startOfToday: () => 0,
  };
}
const exec = (c: ToolContext) => async (name: string, input: unknown) => {
  const r = await runAiTool(c, name, input);
  return { ok: r.ok, content: JSON.stringify(r) };
};

describe('agent loop', () => {
  it('runs tool calls against the real store until the model finishes', async () => {
    const c = ctx();
    const script: LlmResponse[] = [
      { stop: 'tool_use', blocks: [{ type: 'tool_call', id: 'a', name: 'create_drawing', input: { items: [{ kind: 'hline', price: 3340, reason: 'support from two touches' }] } }] },
      { stop: 'tool_use', blocks: [{ type: 'tool_call', id: 'b', name: 'submit_analysis', input: { noSetup: true, dataReference: { timeframes: ['M15'], asOf: '2026-10-24T10:00:00', feed: 'MT5' }, marketStructure: { state: 'ranging', summary: 'Inside range' }, levels: [{ price: 3340, kind: 'support', reason: 'x' }], scenarios: [], invalidation: 'Close below 3335', missingInformation: ['news'], actionsTaken: ['drew S1'] } }] },
      { stop: 'end', blocks: [{ type: 'text', text: 'Done.' }] },
    ];
    let i = 0;
    const events: string[] = [];
    const r = await runAgent([{ role: 'user', blocks: [{ type: 'text', text: 'analyse' }] }], {
      llm: async () => script[i++]!, tools, system: 'S', exec: exec(c), onEvent: (e) => events.push(e.type),
    });
    expect(r.ended).toBe('done');
    expect(c.store.list()).toHaveLength(1);
    expect(c.store.list()[0]!.layer).toBe('ai');
    expect(events.filter((e) => e === 'tool_call')).toHaveLength(2);
    expect(r.added.at(-1)!.blocks[0]).toMatchObject({ type: 'text', text: 'Done.' });
    // every tool_call is answered by a tool_result in the next user message
    expect(r.added[1]!.blocks[0]).toMatchObject({ type: 'tool_result', callId: 'a' });
  });

  it('feeds validation errors back to the model instead of crashing', async () => {
    const c = ctx();
    let seen = '';
    let i = 0;
    await runAgent([{ role: 'user', blocks: [{ type: 'text', text: 'x' }] }], {
      llm: async (q) => {
        if (i++ === 0) return { stop: 'tool_use', blocks: [{ type: 'tool_call', id: 'a', name: 'create_drawing', input: { items: [{ kind: 'hline', price: 3340 }] } }] };
        seen = JSON.stringify(q.messages.at(-1));
        return { stop: 'end', blocks: [{ type: 'text', text: 'fixed' }] };
      },
      tools, system: 'S', exec: exec(c),
    });
    expect(seen).toContain('invalid_input');
    expect(seen).toContain('reason');
  });

  it('stops at max steps and on abort', async () => {
    const c = ctx();
    const loop = async (): Promise<LlmResponse> => ({ stop: 'tool_use', blocks: [{ type: 'tool_call', id: Math.random().toString(), name: 'get_chart_state', input: {} }] });
    expect((await runAgent([], { llm: loop, tools, system: 'S', exec: exec(c), maxSteps: 3 })).ended).toBe('max_steps');
    const ac = new AbortController();
    ac.abort();
    expect((await runAgent([], { llm: loop, tools, system: 'S', exec: exec(c), signal: ac.signal })).ended).toBe('aborted');
  });

  it('truncates huge tool results before they go back to the model', async () => {
    let n = 0;
    const r = await runAgent([], {
      llm: async () => (n++ === 0 ? { stop: 'tool_use', blocks: [{ type: 'tool_call', id: 'a', name: 'get_candles', input: {} }] } : { stop: 'end', blocks: [] }),
      tools, system: 'S', exec: async () => ({ ok: true, content: 'x'.repeat(200_000) }),
    });
    const res = r.added[1]!.blocks[0] as { content: string };
    expect(res.content.length).toBeLessThan(61_000);
    expect(res.content).toContain('truncated');
  });
});

describe('system prompt and analysis tool', () => {
  it('forbids guessing prices and forcing trades; mentions drawing state', () => {
    const on = buildSystemPrompt({ symbol: 'XAUUSD', brokerSymbol: 'GOLD', readOnly: false, canDraw: true, orderMode: 'suggest' });
    expect(on).toMatch(/Never state or assume a price/);
    expect(on).toMatch(/No setup/);
    expect(on).toMatch(/cannot place, modify or close real orders/);
    expect(buildSystemPrompt({ symbol: 'X', brokerSymbol: 'G', readOnly: true, canDraw: false, orderMode: 'suggest' })).toMatch(/Drawing tools are OFF/);
  });
  it('analysis schema rejects a card with no invalidation', async () => {
    const r = await runAiTool(ctx(), 'submit_analysis', { noSetup: true });
    expect(r.ok).toBe(false);
    expect(AI_TOOLS.some((t) => t.name === 'submit_analysis')).toBe(true);
  });
});

import { repairHistory } from '../src';
describe('history repair and privacy', () => {
  it('drops a dangling assistant tool_call', () => {
    const h: ChatMessage[] = [
      { role: 'user', blocks: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'x', name: 'get_chart_state', input: {} }] },
    ];
    expect(repairHistory(h)).toHaveLength(1);
    expect(repairHistory([...h.slice(0, 1), { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }])).toHaveLength(2);
  });
  it('a network error ends the turn cleanly with what was added so far', async () => {
    const r = await runAgent([], { llm: async () => { throw new Error('boom'); }, tools, system: 'S', exec: async () => ({ ok: true, content: '' }) });
    expect(r).toMatchObject({ ended: 'error', error: 'boom', added: [] });
  });
  it('hides balance and money amounts from the AI unless allowed, but still sizes lots', async () => {
    const base = ctx();
    const withAcct = { ...base, getState: () => ({ ...base.getState(), account: { demo: true, currency: 'USD', balance: 10000, equity: 9990 } }), getSpec: () => ({ contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 }) };
    const st = await runAiTool(withAcct, 'get_chart_state', {});
    expect(JSON.stringify(st)).not.toContain('10000');
    const rr = await runAiTool(withAcct, 'calculate_risk_reward', { side: 'buy', entry: 3350, stopLoss: 3343, takeProfits: [3364] });
    expect(rr.ok && (rr.data as any).sizing).toEqual({ lots: 0.07, blocked: null });
    const open = { ...withAcct, exposeBalance: true };
    expect(JSON.stringify(await runAiTool(open, 'get_chart_state', {}))).toContain('10000');
    expect((await runAiTool(open, 'calculate_risk_reward', { side: 'buy', entry: 3350, stopLoss: 3343, takeProfits: [] }) as any).data.sizing.actualRisk).toBeGreaterThan(0);
  });
});

describe('tool schemas are accepted by OpenAI-style providers', () => {
  it('every tool, with every permission on, has a root type:object and no root union', () => {
    const all = toolCatalog(AiPermissionsSchema.parse({ drawingsEdit: true, indicatorsEdit: true, chartControl: true, alertsAndSetups: true, orders: 'confirm', sltpAndPartialClose: true }));
    expect(all.map((t) => t.name)).toContain('propose_order_action');
    for (const t of all) {
      const s = t.inputSchema as Record<string, unknown>;
      expect(s.type, t.name).toBe('object');
      for (const k of ['anyOf', 'oneOf', 'allOf', 'enum', 'not']) expect(s[k], `${t.name} root ${k}`).toBeUndefined();
    }
  });
  it('propose_order_action enforces per-action fields in code', async () => {
    const c = ctx();
    const ctxOrders = { ...c, permissions: AiPermissionsSchema.parse({ orders: 'confirm' }), orders: { orderMode: 'confirm' as const, maxRiskPerTradePct: 0.5, symbol: 'GOLD', positions: async () => [], propose: async () => ({ ok: false as const, error: 'unused' }) } };
    const r = await runAiTool(ctxOrders as never, 'propose_order_action', { action: 'modify_sltp', reason: 'no ticket given' });
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
