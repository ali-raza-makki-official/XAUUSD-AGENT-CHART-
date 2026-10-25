import { describe, expect, it } from 'vitest';
import { attachmentBlocks } from './useWhatsAppAi';

const b64 = (s: string) => btoa(s);

describe('attachmentBlocks', () => {
  it('maps images, PDFs and readable text files; flags unreadable ones honestly', () => {
    const out = attachmentBlocks([
      { kind: 'image', mime: 'image/jpeg', data: 'AAAA' },
      { kind: 'document', mime: 'application/pdf', name: 'r.pdf', data: 'UERG' },
      { kind: 'document', mime: 'text/csv', name: 'trades.csv', data: b64('a,b\n1,2') },
      { kind: 'document', mime: 'application/vnd.ms-excel', name: 'x.xls', data: 'AAAA' },
    ]);
    expect(out[0]).toEqual({ type: 'image', mime: 'image/jpeg', data: 'AAAA' });
    expect(out[1]).toEqual({ type: 'file', mime: 'application/pdf', name: 'r.pdf', data: 'UERG' });
    expect(out[2]).toEqual({ type: 'text', text: 'File "trades.csv":\na,b\n1,2' });
    expect(out[3]).toMatchObject({ type: 'text' });
    expect((out[3] as { text: string }).text).toMatch(/cannot be read/);
  });
});
