import type { ReactNode } from 'react';
import { MousePointer2, Ruler, Type } from 'lucide-react';
import type { ToolId } from './tools';

/** Chart-tool icons share lucide's 24px grid, 1.75 stroke and round caps so the set looks like one family. */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const TOOL_ICONS: Record<ToolId, ReactNode> = {
  cursor: <MousePointer2 size={18} strokeWidth={1.75} aria-hidden="true" />,
  hline: <Svg><path d="M3 12h18" /><circle cx="12" cy="12" r="2.2" /></Svg>,
  vline: <Svg><path d="M12 3v18" /><circle cx="12" cy="12" r="2.2" /></Svg>,
  ray: <Svg><circle cx="5" cy="18" r="2" /><path d="M6.5 16.5L20 5M15 5h5v5" /></Svg>,
  trendline: <Svg><circle cx="5" cy="18" r="2" /><circle cx="19" cy="6" r="2" /><path d="M6.4 16.6l11.2-9.2" /></Svg>,
  channel: <Svg><path d="M3 10L19 4M5 20l16-6" /><path d="M4 15l16-7" strokeDasharray="2 3" /></Svg>,
  zone: <Svg><rect x="3.5" y="7" width="17" height="10" rx="1.5" /><path d="M3.5 12h17" strokeDasharray="2 3" /></Svg>,
  fib: <Svg><path d="M3 5h18M3 10h18M3 15h12M3 20h18" /><path d="M19 5L6 20" strokeDasharray="2 3" /></Svg>,
  long: <Svg><path d="M12 20V5M6 11l6-6 6 6" /></Svg>,
  short: <Svg><path d="M12 4v15M6 13l6 6 6-6" /></Svg>,
  measure: <Ruler size={18} strokeWidth={1.75} aria-hidden="true" />,
  text: <Type size={18} strokeWidth={1.75} aria-hidden="true" />,
};

import type { Drawing } from '@aurum/core';
export const kindIcon = (d: Drawing): ReactNode => TOOL_ICONS[d.kind === 'position' ? (d.side === 'buy' ? 'long' : 'short') : (d.kind as ToolId)];

const NAMES: Record<string, string> = {
  hline: 'Horizontal line', vline: 'Vertical line', ray: 'Ray', trendline: 'Trendline', channel: 'Parallel channel',
  zone: 'Zone', fib: 'Fib retracement', measure: 'Measure', text: 'Text',
};
export const kindName = (d: Drawing): string => (d.kind === 'position' ? (d.side === 'buy' ? 'Long position' : 'Short position') : (NAMES[d.kind] ?? d.kind));
