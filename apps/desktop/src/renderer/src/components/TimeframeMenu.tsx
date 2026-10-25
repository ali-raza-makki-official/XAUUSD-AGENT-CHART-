import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Clock } from 'lucide-react';
import { TIMEFRAMES, TIMEFRAME_LABEL, type Timeframe } from '@aurum/core';

const GROUPS: { title: string; items: Timeframe[] }[] = [
  { title: 'Minutes', items: TIMEFRAMES.filter((t) => t.startsWith('M') && t !== 'MN1') },
  { title: 'Hours', items: TIMEFRAMES.filter((t) => t.startsWith('H')) },
  { title: 'Days and longer', items: ['D1', 'W1', 'MN1'] },
];

/** Timeframe picker as a dropdown: every period MT5 offers, grouped, current one marked. */
export function TimeframeMenu({ value, onChange, label = 'Timeframe' }: { value: Timeframe; onChange: (t: Timeframe) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: r.bottom + 4 });
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key, true);
    pop.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key, true); };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" className="btn btn-sm tfmenu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}: ${TIMEFRAME_LABEL[value]}`} title={`${label} (${TIMEFRAME_LABEL[value]})`} onClick={toggle}>
        <Clock size={14} aria-hidden="true" /><span className="mono">{value}</span><ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="tfmenu" role="menu" aria-label={label} style={{ left: pos.left, top: pos.top }}>
          {GROUPS.map((g) => (
            <div key={g.title} className="tfgroup">
              <div className="tftitle">{g.title}</div>
              <div className="tfgrid">
                {g.items.map((t) => (
                  <button key={t} type="button" role="menuitemradio" aria-checked={t === value} className="tfitem" title={TIMEFRAME_LABEL[t]} aria-label={TIMEFRAME_LABEL[t]} onClick={() => { onChange(t); setOpen(false); btn.current?.focus(); }}>
                    <span className="mono">{t}</span>{t === value && <Check size={12} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>, document.body)}
    </>
  );
}
