import { Activity, Columns2, Grid2x2, Link2, Maximize2, Minimize2, PanelRightOpen, Square } from 'lucide-react';
import { LAYOUT_LABEL, type ChartLayout, type Timeframe } from '@aurum/core';
import { Button, IconButton, Segmented } from './ui';
import { TimeframeMenu } from './TimeframeMenu';

interface Props {
  layout: ChartLayout;
  onLayout: (l: ChartLayout) => void;
  syncScroll: boolean;
  onSync: () => void;
  activePane: number;
  activeTf: Timeframe;
  onTf: (t: Timeframe) => void;
  indicatorCount: number;
  onIndicators: () => void;
  chartFull: boolean;
  onChartFull: () => void;
  rightHidden: boolean;
  onShowRight: () => void;
}

/** Strip above the charts: indicators, layout and linked scrolling. Same functions the AI set_layout tool calls. */
export function LayoutBar({ layout, onLayout, syncScroll, onSync, activePane, activeTf, onTf, indicatorCount, onIndicators, chartFull, onChartFull, rightHidden, onShowRight }: Props) {
  const icon = (l: ChartLayout) => (l === 'single' ? <Square size={14} aria-hidden="true" /> : l === 'two' ? <Columns2 size={14} aria-hidden="true" /> : <Grid2x2 size={14} aria-hidden="true" />);
  return (
    <div className="chartstrip" role="toolbar" aria-label="Chart layout and indicators">
      <TimeframeMenu value={activeTf} onChange={onTf} label={layout === 'single' ? 'Timeframe' : `Timeframe of chart ${activePane + 1}`} />
      <Button size="sm" icon={Activity} onClick={onIndicators} aria-label="Indicators">
        Indicators{indicatorCount > 0 && <span className="count">{indicatorCount}</span>}
      </Button>
      <span className="spacer" />
      {layout !== 'single' && <span className="hint mono" aria-live="polite">Active chart {activePane + 1} · {activeTf}</span>}
      <IconButton
        label={syncScroll ? 'Synced scrolling: on' : 'Synced scrolling: off'}
        tip={syncScroll ? 'Synced scrolling is on: all charts scroll and zoom together' : 'Synced scrolling is off. The crosshair is always linked.'}
        pressed={syncScroll} disabled={layout === 'single'} onClick={onSync}
      ><Link2 size={16} strokeWidth={1.8} /></IconButton>
      <Segmented<ChartLayout>
        label="Chart layout" size="sm" value={layout} onChange={onLayout}
        options={(['single', 'two', 'four'] as ChartLayout[]).map((l) => ({
          value: l, title: LAYOUT_LABEL[l],
          label: <>{icon(l)}<span className="sr-only">{LAYOUT_LABEL[l]}</span><span aria-hidden="true">{l === 'single' ? '1' : l === 'two' ? '2' : '4'}</span></>,
        }))}
      />
      <IconButton label={chartFull ? 'Exit chart full screen (Esc)' : 'Chart full screen'} pos="bottom" onClick={onChartFull}>
        {chartFull ? <Minimize2 size={16} strokeWidth={1.8} /> : <Maximize2 size={16} strokeWidth={1.8} />}
      </IconButton>
      {rightHidden && !chartFull && <IconButton label="Show the side panel" pos="bottom" onClick={onShowRight}><PanelRightOpen size={16} strokeWidth={1.8} /></IconButton>}
    </div>
  );
}
