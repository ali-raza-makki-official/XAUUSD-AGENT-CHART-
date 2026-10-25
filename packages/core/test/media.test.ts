import { describe, expect, it } from 'vitest';
import { PROVIDERS, dropOldMedia, runAgent, type ChatMessage, type LlmRequest } from '../src';

const IMG = { type: 'image' as const, mime: 'image/png', data: 'QUJD' };
const req = (messages: ChatMessage[]): LlmRequest => ({ system: 's', messages, tools: [], maxTokens: 100 });
const cfg = { baseUrl: 'https://x.test', model: 'm', key: 'k' };
const user = (...blocks: ChatMessage['blocks']): ChatMessage => ({ role: 'user', blocks });

describe('images in providers', () => {
  const msgs = [user({ type: 'text', text: 'what is this?' }, IMG)];
  it('anthropic: base64 image block', () => {
    const b = JSON.parse(PROVIDERS.anthropic.buildChat(cfg, req(msgs)).body!);
    expect(b.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  });
  it('openai: image_url data URL; deepseek: text note, no image', () => {
    const o = JSON.parse(PROVIDERS.openai.buildChat(cfg, req(msgs)).body!);
    expect(o.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    const d = JSON.parse(PROVIDERS.deepseek.buildChat(cfg, req(msgs)).body!);
    expect(JSON.stringify(d)).not.toContain('QUJD');
    expect(d.messages[1].content).toMatch(/cannot see images/);
  });
  it('gemini: inlineData', () => {
    const g = JSON.parse(PROVIDERS.gemini.buildChat(cfg, req(msgs)).body!);
    expect(g.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'QUJD' } });
  });
  it('pdf: anthropic document, openai file, deepseek note', () => {
    const pdf = [user({ type: 'file', mime: 'application/pdf', name: 'a.pdf', data: 'UERG' })];
    expect(JSON.parse(PROVIDERS.anthropic.buildChat(cfg, req(pdf)).body!).messages[0].content[0].type).toBe('document');
    expect(JSON.parse(PROVIDERS.openai.buildChat(cfg, req(pdf)).body!).messages[1].content[0].type).toBe('file');
    expect(JSON.parse(PROVIDERS.deepseek.buildChat(cfg, req(pdf)).body!).messages[1].content).toMatch(/cannot read files/);
  });
});

describe('agent loop pictures', () => {
  it('a tool picture is shown to the model as a user image after the tool results', async () => {
    const seen: ChatMessage[][] = [];
    let n = 0;
    const r = await runAgent([user({ type: 'text', text: 'show chart' })], {
      system: 's', tools: [],
      llm: async (q) => { seen.push(q.messages); return n++ === 0 ? { blocks: [{ type: 'tool_call', id: 'c1', name: 'get_chart_image', input: {} }], stop: 'tool_use' } : { blocks: [{ type: 'text', text: 'done' }], stop: 'end' }; },
      exec: async () => ({ ok: true, content: '{"ok":true}', images: [{ mime: 'image/png', data: 'QUJD' }] }),
    });
    expect(r.ended).toBe('done');
    const second = seen[1]!.at(-1)!;
    expect(second.blocks.map((b) => b.type)).toEqual(['tool_result', 'image']);
  });
  it('dropOldMedia keeps only the newest image', () => {
    const h = [user(IMG), { role: 'assistant' as const, blocks: [{ type: 'text' as const, text: 'ok' }] }, user(IMG)];
    const out = dropOldMedia(h, 1);
    expect(out[0]!.blocks[0]).toMatchObject({ type: 'text' });
    expect(out[2]!.blocks[0]).toMatchObject({ type: 'image' });
  });
});
