import { useEffect, useState, type ReactNode } from 'react';

/** Text field that commits on blur/Enter, so typing does not create one undo step per keystroke. */
export function CommitText({ value, onCommit, label, max = 200, multiline = false }: { value: string; onCommit: (v: string) => void; label: string; max?: number; multiline?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => v !== value && onCommit(v);
  const common = { value: v, maxLength: max, 'aria-label': label, onChange: (e: { target: { value: string } }) => setV(e.target.value), onBlur: done };
  return multiline
    ? <textarea className="textarea" rows={2} {...common} />
    : <input className="input" {...common} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

export function CommitNumber({ value, onCommit, label, step = 0.01, min, max, digits = 2 }: { value: number; onCommit: (v: number) => void; label: string; step?: number; min?: number; max?: number; digits?: number }) {
  const fmt = (n: number) => String(Number(n.toFixed(digits)));
  const [v, setV] = useState(fmt(value));
  useEffect(() => setV(fmt(value)), [value, digits]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value && (min === undefined || n >= min) && (max === undefined || n <= max)) onCommit(n);
    else setV(fmt(value));
  };
  return <input className="input mono" type="number" step={step} min={min} max={max} value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

export function ColorField({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type="color" value={v} aria-label={label} title={v.toUpperCase()} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} />;
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="irow"><span className="ilabel">{label}</span><div className="ictl">{children}</div></div>
);
