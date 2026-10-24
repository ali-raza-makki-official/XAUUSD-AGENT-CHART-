import type { ReactNode } from 'react';

/** Tiny safe renderer (paragraphs, bullet lists, **bold**, `code`). Builds React nodes only, never HTML strings. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <strong key={m.index}>{t.slice(2, -2)}</strong> : <code key={m.index} className="mono md-code">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, k) => <span key={k}>{k > 0 && <br />}{inline(l)}</span>)}</p>;
      })}
    </div>
  );
}
