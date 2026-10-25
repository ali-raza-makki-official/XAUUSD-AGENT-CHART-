import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

type Pos = 'top' | 'bottom' | 'left' | 'right';

/** Tooltip rendered in a portal with fixed positioning, so scroll containers and panels can never clip or cover it. */
export function Tip({ label, pos = 'bottom', children }: { label: string; pos?: Pos; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      setAt(
        pos === 'right' ? { x: r.right + 8, y: r.top + r.height / 2 }
        : pos === 'left' ? { x: r.left - 8, y: r.top + r.height / 2 }
        : pos === 'top' ? { x: r.left + r.width / 2, y: r.top - 6 }
        : { x: r.left + r.width / 2, y: r.bottom + 6 },
      );
    }, 350);
  };
  const hide = () => { window.clearTimeout(timer.current); setAt(null); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span ref={ref} className="tip" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onMouseDown={hide}>
      {children}
      {at && createPortal(<span role="tooltip" className="tip-pop" data-pos={pos} style={{ left: at.x, top: at.y }}>{label}</span>, document.body)}
    </span>
  );
}

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: LucideIcon;
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, children, className = '', ...rest }: BtnProps) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {Icon && <Icon size={14} strokeWidth={1.9} aria-hidden="true" />}
      {children}
    </button>
  );
}

interface IconBtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label'> {
  label: string;
  tip?: string;
  pos?: Pos;
  pressed?: boolean;
  tone?: 'default' | 'danger';
  children: ReactNode;
}

export function IconButton({ label, tip, pos = 'bottom', pressed, tone = 'default', children, className = '', ...rest }: IconBtnProps) {
  return (
    <Tip label={tip ?? label} pos={pos}>
      <button type="button" className={`ibtn ${tone === 'danger' ? 'ibtn-danger' : ''} ${className}`} aria-label={label} aria-pressed={pressed} {...rest}>{children}</button>
    </Tip>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md' }) {
  return (
    <div className={`seg seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title} className="seg-item" onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'ai' | 'gold';
export function Chip({ tone = 'neutral', icon: Icon, children, title }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {Icon && <Icon size={12} strokeWidth={2} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export const Section = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => (
  <section className="sect">
    <div className="sect-h"><h4>{title}</h4>{action}</div>
    <div className="sect-b">{children}</div>
  </section>
);

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;
