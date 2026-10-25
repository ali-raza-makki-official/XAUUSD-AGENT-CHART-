import { describe, expect, it } from 'vitest';
import { makeTranscriber } from './transcribe';

const cfg = { ai: { provider: null, models: { gemini: 'gemini-x' }, baseUrls: {} } } as never;
const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/ogg; codecs=opus' };

describe('transcriber', () => {
  it('uses OpenAI transcription when that key exists', async () => {
    const calls: { url: string; auth: string; model: unknown }[] = [];
    const t = makeTranscriber({ getConfig: () => cfg, getKey: (p) => (p === 'openai' ? 'sk' : null), fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization!, model: (init.body as FormData).get('model') });
      return new Response(JSON.stringify({ text: 'gold kahan hai' }), { status: 200 });
    }) as never });
    expect(await t.transcribe(audio)).toBe('gold kahan hai');
    expect(calls[0]).toEqual({ url: 'https://api.openai.com/v1/audio/transcriptions', auth: 'Bearer sk', model: 'gpt-4o-mini-transcribe' });
  });
  it('falls back to Gemini audio input', async () => {
    let body = '';
    const t = makeTranscriber({ getConfig: () => cfg, getKey: (p) => (p === 'gemini' ? 'gk' : null), fetchImpl: (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' hello ' }] } }] }), { status: 200 });
    }) as never });
    expect(await t.transcribe(audio)).toBe('hello');
    expect(body).toContain('"mimeType":"audio/ogg"');
  });
  it('says clearly when no provider can hear audio', async () => {
    const t = makeTranscriber({ getConfig: () => cfg, getKey: () => null });
    await expect(t.transcribe(audio)).rejects.toThrow(/OpenAI or Gemini/);
  });
});
