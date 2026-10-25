import { describe, expect, it } from 'vitest';
import { makeTranscriber, voiceRoute } from './transcribe';

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

  it('when the chosen chat model hears audio itself (Gemini), it is used even if an OpenAI key also exists', async () => {
    const urls: string[] = [];
    const gcfg = { ai: { provider: 'gemini', models: { gemini: 'gemini-2.5-flash' }, baseUrls: {} } } as never;
    const t = makeTranscriber({ getConfig: () => gcfg, getKey: () => 'k', fetchImpl: (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }), { status: 200 }); }) as never });
    expect(await t.transcribe(audio)).toBe('hi');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('gemini-2.5-flash:generateContent');
  });

  it('Anthropic or DeepSeek chosen: voice goes to OpenAI speech-to-text only because the chat model cannot hear', () => {
    const acfg = { ai: { provider: 'anthropic', models: { anthropic: 'claude-sonnet-5-5' }, baseUrls: {} } } as never;
    expect(voiceRoute({ getConfig: () => acfg, getKey: (p) => (p === 'openai' ? 'k' : null) })).toEqual({ by: 'openai' });
    expect(voiceRoute({ getConfig: () => acfg, getKey: () => null })).toBeNull();
  });
});
