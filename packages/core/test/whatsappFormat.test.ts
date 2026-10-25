import { describe, expect, it } from 'vitest';
import { formatForWhatsApp } from '../src/whatsappFormat';
import { buildSystemPrompt } from '../src/llm';

describe('formatForWhatsApp', () => {
  it('converts markdown to WhatsApp style without touching numbers', () => {
    const out = formatForWhatsApp('## Setup\n**Entry:** 2650.40\n* SL 2640.40\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n[chart](https://x.io/a)');
    expect(out).toBe('*Setup*\n*Entry:* 2650.40\n- SL 2640.40\n\n- a · b\n- 1 · 2\nchart (https://x.io/a)');
  });
  it('keeps code fence contents and is idempotent', () => {
    const once = formatForWhatsApp('```\nx = **1**\n```\n*ok*');
    expect(once).toBe('x = **1**\n*ok*');
    const plain = formatForWhatsApp('## A\n**b** 1.5');
    expect(formatForWhatsApp(plain)).toBe(plain);
  });
});

describe('prompt channel', () => {
  const base = { symbol: 'XAUUSD', brokerSymbol: 'XAUUSDm', readOnly: false, canDraw: true, orderMode: 'suggest' as const };
  it('adds the WhatsApp style only for the whatsapp channel', () => {
    expect(buildSystemPrompt({ ...base, channel: 'whatsapp' })).toContain('WhatsApp reply style');
    expect(buildSystemPrompt(base)).not.toContain('WhatsApp reply style');
  });
});
