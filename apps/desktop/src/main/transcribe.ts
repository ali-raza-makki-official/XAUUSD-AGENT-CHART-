import { modelCaps, PROVIDERS, type AppConfig, type ProviderId, type Transcriber } from '@aurum/core';

/**
 * Voice note -> text through a provider the user already configured. Anthropic and DeepSeek have no audio input,
 * so OpenAI (transcription endpoint) or Gemini (audio in generateContent) is used when its key is saved.
 * The audio goes to that provider only; nothing is stored.
 */
export interface TranscriberDeps {
  getConfig: () => Pick<AppConfig, 'ai'>;
  getKey: (p: ProviderId) => string | null;
  fetchImpl?: typeof fetch;
}

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const ext = (mime: string) => (/ogg|opus/i.test(mime) ? 'ogg' : /mpeg|mp3/i.test(mime) ? 'mp3' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : /wav/i.test(mime) ? 'wav' : /webm/i.test(mime) ? 'webm' : 'ogg');
const baseOf = (c: Pick<AppConfig, 'ai'>, p: ProviderId, fallback: string) => (c.ai.baseUrls[p] || fallback).replace(/\/+$/, '');

export type VoiceRoute = { by: 'model' | 'gemini'; model: string } | { by: 'openai' } | null;

/**
 * Who turns a voice note into text. A chat model that hears audio itself does it directly (no other service is
 * involved); only when it cannot do we use another provider's speech-to-text that the user has a key for.
 */
export function voiceRoute(d: Pick<TranscriberDeps, 'getConfig' | 'getKey'>): VoiceRoute {
  const cfg = d.getConfig();
  const active = cfg.ai.provider;
  if (active) {
    const model = cfg.ai.models[active] || PROVIDERS[active].suggestedModel;
    if (modelCaps(active, model).audioIn && active === 'gemini' && d.getKey('gemini')) return { by: 'model', model };
  }
  if (d.getKey('openai')) return { by: 'openai' };
  const gm = cfg.ai.models.gemini;
  if (d.getKey('gemini') && gm && modelCaps('gemini', gm).audioIn) return { by: 'gemini', model: gm };
  return null;
}

export function makeTranscriber(d: TranscriberDeps): Transcriber {
  const f = d.fetchImpl ?? fetch;
  return {
    async transcribe(audio) {
      if (audio.bytes.byteLength > MAX_BYTES) throw new Error('That voice note is too long.');
      const cfg = d.getConfig();
      const mime = audio.mimeType.split(';')[0]!.trim() || 'audio/ogg';
      const route = voiceRoute(d);
      const openaiKey = d.getKey('openai');
      if (route?.by === 'openai' && openaiKey) {
        const form = new FormData();
        form.append('model', 'gpt-4o-mini-transcribe');
        form.append('file', new Blob([audio.bytes as BlobPart], { type: mime }), `voice.${ext(mime)}`);
        const res = await f(`${baseOf(cfg, 'openai', 'https://api.openai.com')}/v1/audio/transcriptions`, {
          method: 'POST', headers: { authorization: `Bearer ${openaiKey}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const json = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
        if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}). ${json.error?.message ?? ''}`.trim());
        return String(json.text ?? '');
      }
      const geminiKey = d.getKey('gemini');
      if ((route?.by === 'model' || route?.by === 'gemini') && geminiKey) {
        const model = route.model;
        const res = await f(`${baseOf(cfg, 'gemini', 'https://generativelanguage.googleapis.com')}/v1beta/models/${model.replace(/^models\//, '')}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey }, signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({ contents: [{ role: 'user', parts: [
            { text: 'Transcribe this voice note word for word in the language spoken. Output only the transcript, nothing else. If there is no speech, output nothing.' },
            { inlineData: { mimeType: mime, data: Buffer.from(audio.bytes).toString('base64') } },
          ] }] }),
        });
        const json = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
        if (!res.ok) throw new Error(`Gemini transcription failed (${res.status}). ${json.error?.message ?? ''}`.trim());
        return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      }
      throw new Error('Voice notes need an OpenAI or Gemini API key (Settings > AI). Anthropic and DeepSeek cannot hear audio.');
    },
  };
}
