import { PROVIDERS, type AppConfig, type HttpRequest, type LlmRequest, type LlmResponse, type ProviderId } from '@aurum/core';
import { getKey } from './secrets';

const TIMEOUT_MS = 120_000;
const inflight = new Map<string, AbortController>();

/** https everywhere, except loopback (local models or a test server). */
function assertSafeUrl(u: string): void {
  const url = new URL(u);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Provider URL must use https (http is allowed only for localhost).');
}

const scrub = (text: string, key: string) => (key ? text.split(key).join('***') : text);

async function send(provider: ProviderId, http: HttpRequest, key: string, signal: AbortSignal): Promise<unknown> {
  assertSafeUrl(http.url);
  let res: Response;
  try {
    res = await fetch(http.url, { method: http.method, headers: http.headers, body: http.body, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  } catch (e) {
    if (signal.aborted) throw new Error('Stopped.');
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'The provider took too long to answer.' : e.message) : String(e);
    throw new Error(scrub(`Could not reach ${PROVIDERS[provider].label}: ${msg}`, key));
  }
  const text = await res.text();
  let json: unknown = {};
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(scrub(PROVIDERS[provider].parseError(res.status, json), key));
  return json;
}

function resolve(config: AppConfig, provider: ProviderId) {
  const adapter = PROVIDERS[provider];
  const key = getKey(provider);
  if (!key) throw new Error(`No API key saved for ${adapter.label}. Add it in Settings > AI.`);
  const model = config.ai.models[provider] || adapter.suggestedModel;
  const baseUrl = config.ai.baseUrls[provider] || adapter.defaultBaseUrl;
  return { adapter, key, model, baseUrl };
}

export async function chat(config: AppConfig, requestId: string, req: LlmRequest): Promise<LlmResponse> {
  const provider = config.ai.provider;
  if (!provider) throw new Error('Choose an AI provider in Settings > AI first.');
  const { adapter, key, model, baseUrl } = resolve(config, provider);
  if (!model) throw new Error(`Choose a model for ${adapter.label} in Settings > AI (use "Load models").`);
  const ctl = new AbortController();
  inflight.set(requestId, ctl);
  try {
    return adapter.parseChat(await send(provider, adapter.buildChat({ baseUrl, model, key }, req), key, ctl.signal));
  } finally {
    inflight.delete(requestId);
  }
}

export function abort(requestId: string): void {
  inflight.get(requestId)?.abort();
}

export async function listModels(config: AppConfig, provider: ProviderId): Promise<string[]> {
  const adapter = PROVIDERS[provider];
  const key = getKey(provider);
  if (!key) throw new Error(`No API key saved for ${adapter.label}.`);
  const baseUrl = config.ai.baseUrls[provider] || adapter.defaultBaseUrl;
  return adapter.parseModels(await send(provider, adapter.buildModels({ baseUrl, key }), key, new AbortController().signal));
}

/** Smallest real round-trip with the chosen model: proves key, model name and tool-free chat all work. */
export async function test(config: AppConfig, provider: ProviderId): Promise<{ ms: number; reply: string }> {
  const adapter = PROVIDERS[provider];
  const { key, model, baseUrl } = resolve(config, provider);
  if (!model) throw new Error('Choose a model first.');
  const t0 = Date.now();
  const json = await send(provider, adapter.buildChat({ baseUrl, model, key }, { system: 'Reply with the single word OK.', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'ping' }] }], tools: [], maxTokens: 16 }), key, new AbortController().signal);
  const r = adapter.parseChat(json);
  return { ms: Date.now() - t0, reply: r.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').slice(0, 40) };
}
