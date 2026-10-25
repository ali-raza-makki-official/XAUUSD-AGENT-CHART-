import { modelCaps, type ListedCaps } from './modelCaps';
import type { Block, ChatMessage, LlmRequest, LlmResponse, StopReason, ToolSpec } from './llm';

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'deepseek';
export const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'deepseek'];

export interface HttpRequest { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }
export interface ProviderCfg { baseUrl: string; model: string; key: string }

export interface ProviderCaps { tools: boolean; vision: boolean; streaming: boolean }

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  /** Suggested model; models differ per account, so the UI also lists the real ones from the provider. */
  suggestedModel: string;
  caps: ProviderCaps;
  buildChat(cfg: ProviderCfg, req: LlmRequest): HttpRequest;
  parseChat(json: unknown): LlmResponse;
  buildModels(cfg: Omit<ProviderCfg, 'model'>): HttpRequest;
  parseModels(json: unknown): string[];
  /** Capabilities the provider's own model list reports (Anthropic does), keyed by model id. */
  parseModelCaps?(json: unknown): Record<string, ListedCaps>;
  parseError(status: number, json: unknown): string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;
const textOf = (b: Block[]) => b.filter((x): x is Extract<Block, { type: 'text' }> => x.type === 'text').map((x) => x.text).join('\n');
const callsOf = (b: Block[]) => b.filter((x): x is Extract<Block, { type: 'tool_call' }> => x.type === 'tool_call');
const imagesOf = (b: Block[]) => b.filter((x): x is Extract<Block, { type: 'image' }> => x.type === 'image');
const filesOf = (b: Block[]) => b.filter((x): x is Extract<Block, { type: 'file' }> => x.type === 'file');
const NO_IMAGE = '[An image was attached but this model cannot see images. Tell the user plainly and do not guess what it shows.]';
const noFile = (name: string) => `[A file "${name}" was attached but this model cannot read files. Tell the user plainly and do not guess its contents.]`;
const resultsOf = (b: Block[]) => b.filter((x): x is Extract<Block, { type: 'tool_result' }> => x.type === 'tool_result');

function errMessage(status: number, json: unknown): string {
  const j = asObj(json);
  const detail = j.error?.message ?? j.error?.status ?? j.message ?? (typeof j.error === 'string' ? j.error : '');
  if (status === 401 || status === 403) return `The provider rejected the API key (${status}). ${detail}`.trim();
  if (status === 429) return `Rate limit or quota reached (429). ${detail}`.trim();
  if (status >= 500) return `The provider had a server error (${status}). Try again shortly. ${detail}`.trim();
  return `Provider error ${status}. ${detail}`.trim();
}

/** Keep only schema keywords every provider tolerates. Used for Gemini, whose function schema is an OpenAPI subset. */
const GEMINI_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'anyOf', 'minimum', 'maximum', 'minItems', 'maxItems']);
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const o = { ...(s as Json) };
  if ('const' in o) { o.enum = [o.const]; delete o.const; if (!o.type) o.type = typeof o.enum[0]; }
  if (Array.isArray(o.type)) {
    const t = o.type.filter((x: string) => x !== 'null');
    if (t.length !== o.type.length) o.nullable = true;
    o.type = t[0] ?? 'string';
  }
  if (o.type === 'integer' || o.type === 'number' || o.type === 'string' || o.type === 'boolean' || o.type === 'array' || o.type === 'object') { /* ok */ }
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items' || k === 'anyOf') out[k] = toGeminiSchema(v);
    else out[k] = v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

const stripSchemaMeta = (s: unknown): unknown => {
  if (Array.isArray(s)) return s.map(stripSchemaMeta);
  if (!s || typeof s !== 'object') return s;
  return Object.fromEntries(Object.entries(s as Json).filter(([k]) => k !== '$schema').map(([k, v]) => [k, stripSchemaMeta(v)]));
};

// ---------------------------------------------------------------- Anthropic
export const anthropic: ProviderAdapter = {
  id: 'anthropic', label: 'Anthropic (Claude)', defaultBaseUrl: 'https://api.anthropic.com', suggestedModel: 'claude-sonnet-5-5',
  caps: { tools: true, vision: true, streaming: false },
  buildChat(cfg, req) {
    const caps = modelCaps('anthropic', cfg.model);
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.blocks.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image' && !caps.vision) return { type: 'text', text: NO_IMAGE };
        if (b.type === 'file' && !caps.pdf) return { type: 'text', text: noFile(b.name) };
        if (b.type === 'tool_call') return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
        if (b.type === 'image') return { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } };
        if (b.type === 'file') return b.mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: b.mime, data: b.data } } : { type: 'text', text: noFile(b.name) };
        return { type: 'tool_result', tool_use_id: b.callId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
      }),
    }));
    return {
      url: join(cfg.baseUrl, '/v1/messages'), method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages,
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: stripSchemaMeta(t.inputSchema) })) } : {}),
      }),
    };
  },
  parseChat(json) {
    const j = asObj(json);
    const blocks: Block[] = (Array.isArray(j.content) ? j.content : []).flatMap((c: Json): Block[] => {
      if (c.type === 'text') return [{ type: 'text', text: String(c.text ?? '') }];
      if (c.type === 'tool_use') return [{ type: 'tool_call', id: String(c.id), name: String(c.name), input: c.input ?? {} }];
      return [];
    });
    const stop: StopReason = j.stop_reason === 'tool_use' ? 'tool_use' : j.stop_reason === 'max_tokens' ? 'max_tokens' : j.stop_reason === 'end_turn' ? 'end' : 'other';
    return { blocks, stop, usage: j.usage ? { input: Number(j.usage.input_tokens ?? 0), output: Number(j.usage.output_tokens ?? 0) } : undefined };
  },
  buildModels(cfg) {
    return { url: join(cfg.baseUrl, '/v1/models?limit=100'), method: 'GET', headers: { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' } };
  },
  parseModels: (json) => (Array.isArray(asObj(json).data) ? asObj(json).data.map((m: Json) => String(m.id)) : []),
  parseModelCaps: (json) => Object.fromEntries((Array.isArray(asObj(json).data) ? asObj(json).data : []).filter((m: Json) => m.capabilities && typeof m.capabilities === 'object').map((m: Json) => [String(m.id), m.capabilities as ListedCaps])),
  parseError: errMessage,
};

// ------------------------------------------------- OpenAI-compatible (OpenAI, DeepSeek, custom)
function openaiMessages(system: string, messages: ChatMessage[], vision: boolean): Json[] {
  const out: Json[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const calls = callsOf(m.blocks);
      out.push({
        role: 'assistant', content: textOf(m.blocks) || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
    } else {
      for (const r of resultsOf(m.blocks)) out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
      const t = textOf(m.blocks);
      const imgs = imagesOf(m.blocks), files = filesOf(m.blocks);
      if (!vision) {
        const notes = [...imgs.map(() => NO_IMAGE), ...files.map((f) => noFile(f.name))];
        if (t || notes.length) out.push({ role: 'user', content: [t, ...notes].filter(Boolean).join('\n') });
      } else if (imgs.length || files.length) {
        out.push({ role: 'user', content: [
          ...(t ? [{ type: 'text', text: t }] : []),
          ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
          ...files.map((f) => (f.mime === 'application/pdf' ? { type: 'file', file: { filename: f.name, file_data: `data:${f.mime};base64,${f.data}` } } : { type: 'text', text: noFile(f.name) })),
        ] });
      } else if (t) out.push({ role: 'user', content: t });
    }
  }
  return out;
}

const toolsOpenAI = (tools: ToolSpec[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: stripSchemaMeta(t.inputSchema) } }));

function openaiLike(id: 'openai' | 'deepseek', label: string, baseUrl: string, suggested: string, maxTokensParam: string): ProviderAdapter {
  return {
    id, label, defaultBaseUrl: baseUrl, suggestedModel: suggested, caps: { tools: true, vision: id === 'openai', streaming: false },
    buildChat(cfg, req) {
      return {
        url: join(cfg.baseUrl, id === 'openai' ? '/v1/chat/completions' : '/chat/completions'), method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: cfg.model, [maxTokensParam]: req.maxTokens, messages: openaiMessages(req.system, req.messages, modelCaps(id, cfg.model).vision),
          ...(req.tools.length ? { tools: toolsOpenAI(req.tools) } : {}),
        }),
      };
    },
    parseChat(json) {
      const j = asObj(json);
      const choice = asObj(j.choices?.[0]);
      const msg = asObj(choice.message);
      const blocks: Block[] = [];
      if (typeof msg.content === 'string' && msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const c of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        let input: unknown;
        try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = { __invalid_json: String(c.function?.arguments ?? '') }; }
        blocks.push({ type: 'tool_call', id: String(c.id), name: String(c.function?.name), input });
      }
      const fr = choice.finish_reason;
      const stop: StopReason = fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : fr === 'stop' ? 'end' : 'other';
      return { blocks, stop, usage: j.usage ? { input: Number(j.usage.prompt_tokens ?? 0), output: Number(j.usage.completion_tokens ?? 0) } : undefined };
    },
    buildModels(cfg) {
      return { url: join(cfg.baseUrl, id === 'openai' ? '/v1/models' : '/models'), method: 'GET', headers: { authorization: `Bearer ${cfg.key}` } };
    },
    parseModels: (json) => (Array.isArray(asObj(json).data) ? asObj(json).data.map((m: Json) => String(m.id)).sort() : []),
    parseError: errMessage,
  };
}
export const openai = openaiLike('openai', 'OpenAI', 'https://api.openai.com', '', 'max_completion_tokens');
export const deepseek = openaiLike('deepseek', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-chat', 'max_tokens');

// ------------------------------------------------------------------- Gemini
export const gemini: ProviderAdapter = {
  id: 'gemini', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com', suggestedModel: '',
  caps: { tools: true, vision: true, streaming: false },
  buildChat(cfg, req) {
    const gcaps = modelCaps('gemini', cfg.model);
    const contents = req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.blocks.map((b) => {
        if (b.type === 'text') return { text: b.text };
        if (b.type === 'tool_call') return { functionCall: { name: b.name, args: b.input ?? {} } };
        if (b.type === 'image' || b.type === 'file') {
          const ok = b.type === 'image' ? gcaps.vision : gcaps.pdf;
          return ok ? { inlineData: { mimeType: b.mime, data: b.data } } : { text: b.type === 'image' ? NO_IMAGE : noFile(b.name) };
        }
        let response: unknown;
        try { response = JSON.parse(b.content); } catch { response = { result: b.content }; }
        return { functionResponse: { name: b.name, response: b.isError ? { error: response } : (response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response }) } };
      }),
    }));
    const model = cfg.model.startsWith('models/') ? cfg.model : `models/${cfg.model}`;
    return {
      url: join(cfg.baseUrl, `/v1beta/${model}:generateContent`), method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] }, contents,
        generationConfig: { maxOutputTokens: req.maxTokens },
        ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.inputSchema) })) }] } : {}),
      }),
    };
  },
  parseChat(json) {
    const j = asObj(json);
    const cand = asObj(j.candidates?.[0]);
    const blocks: Block[] = [];
    let n = 0;
    for (const p of Array.isArray(cand.content?.parts) ? cand.content.parts : []) {
      if (typeof p.text === 'string' && p.text && !p.thought) blocks.push({ type: 'text', text: p.text });
      if (p.functionCall) blocks.push({ type: 'tool_call', id: `call_${Date.now().toString(36)}_${n++}`, name: String(p.functionCall.name), input: p.functionCall.args ?? {} });
    }
    const hasCall = blocks.some((b) => b.type === 'tool_call');
    const fr = cand.finishReason;
    const stop: StopReason = hasCall ? 'tool_use' : fr === 'MAX_TOKENS' ? 'max_tokens' : fr === 'STOP' ? 'end' : 'other';
    const u = j.usageMetadata;
    return { blocks, stop, usage: u ? { input: Number(u.promptTokenCount ?? 0), output: Number(u.candidatesTokenCount ?? 0) } : undefined };
  },
  buildModels(cfg) {
    return { url: join(cfg.baseUrl, '/v1beta/models?pageSize=200'), method: 'GET', headers: { 'x-goog-api-key': cfg.key } };
  },
  parseModels: (json) => (Array.isArray(asObj(json).models)
    ? asObj(json).models.filter((m: Json) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m: Json) => String(m.name).replace(/^models\//, ''))
    : []),
  parseError: errMessage,
};

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = { anthropic, openai, gemini, deepseek };
