import { z } from 'zod';
import { TimeframeSchema, type Timeframe } from './feed';

/** Multi-chart workspace layouts. All panes show the same symbol from the same MT5 feed. */
export const CHART_LAYOUTS = ['single', 'two', 'four'] as const;
export const ChartLayoutSchema = z.enum(CHART_LAYOUTS);
export type ChartLayout = z.infer<typeof ChartLayoutSchema>;

export const LAYOUT_PANES: Record<ChartLayout, number> = { single: 1, two: 2, four: 4 };
export const LAYOUT_LABEL: Record<ChartLayout, string> = { single: 'Single chart', two: 'Two charts (side by side)', four: 'Four charts (2 x 2)' };

/** Timeframes of the four panes in the 4-chart layout; the 2-chart layout uses the first two. */
export const DEFAULT_PANE_TIMEFRAMES: Timeframe[] = ['H4', 'H1', 'M15', 'M5'];
export const PaneTimeframesSchema = z.array(TimeframeSchema).length(4);

export interface LayoutConfig {
  layout: ChartLayout;
  /** Single-chart timeframe (kept as `timeframe` in the app config for backwards compatibility). */
  timeframe: Timeframe;
  paneTimeframes: Timeframe[];
}

/** Timeframe shown in pane `i`. In the single layout pane 0 uses the classic `timeframe` setting. */
export function paneTimeframe(c: LayoutConfig, i: number): Timeframe {
  if (c.layout === 'single') return c.timeframe;
  return c.paneTimeframes[i] ?? c.paneTimeframes[0] ?? c.timeframe;
}

export function paneTimeframes(c: LayoutConfig): Timeframe[] {
  return Array.from({ length: LAYOUT_PANES[c.layout] }, (_, i) => paneTimeframe(c, i));
}

export const clampPane = (layout: ChartLayout, i: number): number =>
  Math.min(Math.max(0, Math.trunc(Number.isFinite(i) ? i : 0)), LAYOUT_PANES[layout] - 1);

/** Config patch that sets the timeframe of pane `i`. Out-of-range panes are clamped to the last pane of the layout. */
export function withPaneTimeframe(c: LayoutConfig, i: number, tf: Timeframe): { timeframe?: Timeframe; paneTimeframes?: Timeframe[] } {
  const idx = clampPane(c.layout, i);
  if (c.layout === 'single') return { timeframe: tf };
  const next = [...c.paneTimeframes];
  next[idx] = tf;
  return { paneTimeframes: next };
}

/**
 * Config patch for switching layout. `paneTfs` (optional) sets the first N pane timeframes at the same time.
 * Going back to a single chart keeps pane 0's timeframe so the view does not jump.
 */
export function withLayout(c: LayoutConfig, layout: ChartLayout, paneTfs?: Timeframe[]): { layout: ChartLayout; paneTimeframes?: Timeframe[]; timeframe?: Timeframe } {
  const patch: { layout: ChartLayout; paneTimeframes?: Timeframe[]; timeframe?: Timeframe } = { layout };
  if (paneTfs && paneTfs.length) {
    const next = [...c.paneTimeframes];
    paneTfs.slice(0, 4).forEach((tf, i) => { next[i] = tf; });
    if (layout === 'single') patch.timeframe = paneTfs[0]!;
    else patch.paneTimeframes = next;
  } else if (c.layout !== 'single' && layout === 'single') {
    patch.timeframe = c.paneTimeframes[0] ?? c.timeframe;
  }
  return patch;
}

/** Index of the candle containing `time` (last candle at or before it), or -1 if before the first. */
export function candleIndexAt(times: readonly number[], time: number): number {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Convert a visible logical range from one pane to another by TIME, so panes with different
 * timeframes stay aligned. `toTime`/`toLogical` are each pane's own bar-index <-> time mapping.
 */
export function mapLogicalRange(
  range: { from: number; to: number },
  toTime: (logical: number) => number,
  toLogical: (time: number) => number,
): { from: number; to: number } {
  return { from: toLogical(toTime(range.from)), to: toLogical(toTime(range.to)) };
}
