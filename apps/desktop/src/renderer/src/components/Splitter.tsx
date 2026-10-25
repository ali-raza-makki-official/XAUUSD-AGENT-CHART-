import { useRef } from 'react';

interface Props {
  /** 'v' = a vertical bar that resizes a column; 'h' = a horizontal bar that resizes a row. */
  orientation: 'v' | 'h';
  label: string;
  value: number;
  min: number;
  max: number;
  /** Dragging towards the start (left / up) makes the panel bigger. */
  grow: 'start' | 'end';
  onChange: (v: number) => void;
  onReset: () => void;
}

/** Drag, use arrow keys (Shift = bigger steps) or double-click to reset. One panel grows while the other shrinks. */
export function Splitter({ orientation, label, value, min, max, grow, onChange, onReset }: Props) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const axis = orientation === 'v' ? 'clientX' : 'clientY';
  const sign = grow === 'start' ? -1 : 1;
  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator" aria-orientation={orientation === 'v' ? 'vertical' : 'horizontal'} aria-label={label}
      aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { start: e[axis], value }; document.body.classList.add('resizing'); }}
      onPointerMove={(e) => { if (drag.current) onChange(drag.current.value + sign * (e[axis] - drag.current.start)); }}
      onPointerUp={(e) => { drag.current = null; e.currentTarget.releasePointerCapture(e.pointerId); document.body.classList.remove('resizing'); }}
      onPointerCancel={() => { drag.current = null; document.body.classList.remove('resizing'); }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const dir = orientation === 'v' ? (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0) : (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0);
        if (dir) { e.preventDefault(); onChange(value + sign * dir * step); }
        if (e.key === 'Home') { e.preventDefault(); onChange(min); }
        if (e.key === 'End') { e.preventDefault(); onChange(max); }
      }}
    />
  );
}
