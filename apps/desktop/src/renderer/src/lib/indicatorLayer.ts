import {
  HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import {
  INDICATORS, computeIndicator, indicatorTitle, isIndicatorShownOn, outputStyle,
  type Candle, type Indicator, type Series, type Timeframe,
} from '@aurum/core';

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;
const HIST_STRETCH = 3; // the price pane is this many times taller than each indicator pane

interface OutputSeries { key: string; kind: 'line' | 'histogram'; series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>; lines: IPriceLine[] }
interface Entry { sig: string; ind: Indicator; paneIndex: number; outputs: OutputSeries[] }

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/**
 * Draws indicator instances on a lightweight-charts chart: overlays share the price pane, RSI/MACD/ATR/Stochastic get
 * their own panes below. Values always come from `computeIndicator` on the real candles; on a tick only the last
 * point is re-sent. Rebuilds only the series whose parameters, style or pane changed.
 */
export class IndicatorLayer {
  private entries = new Map<string, Entry>();

  constructor(private readonly chart: IChartApi) {}

  /** Make the chart show exactly the indicators that apply to `tf`. */
  sync(all: Indicator[], tf: Timeframe, candles: readonly Candle[]): void {
    const shown = all.filter((i) => isIndicatorShownOn(i, tf));
    let nextPane = 1;
    const wanted = shown.map((ind) => {
      const paneIndex = INDICATORS[ind.type].placement === 'pane' ? nextPane++ : 0;
      return { ind, paneIndex, sig: JSON.stringify([ind.type, ind.params, ind.style, ind.label, paneIndex]) };
    });

    for (const [id, e] of [...this.entries]) {
      const w = wanted.find((x) => x.ind.id === id);
      if (!w || w.sig !== e.sig) this.drop(id);
    }
    // Create in ascending pane order so a new pane always follows an existing one.
    for (const w of [...wanted].sort((a, b) => a.paneIndex - b.paneIndex)) {
      const cur = this.entries.get(w.ind.id);
      if (cur) { cur.ind = w.ind; continue; }
      this.entries.set(w.ind.id, this.create(w.ind, w.paneIndex, w.sig));
    }
    this.setData(candles);
    this.layoutPanes();
  }

  /** Recompute everything on the full candle array (history loaded, or an indicator was just added). */
  setData(candles: readonly Candle[]): void {
    for (const e of this.entries.values()) {
      const out = this.compute(e.ind, candles);
      for (const o of e.outputs) o.series.setData(this.points(o, e.ind, candles, out[o.key] ?? []) as never);
    }
  }

  /** Live update: recompute on the live candle array, send only the last point of each output. */
  updateLast(candles: readonly Candle[]): void {
    if (!candles.length || !this.entries.size) return;
    const i = candles.length - 1;
    for (const e of this.entries.values()) {
      const out = this.compute(e.ind, candles);
      for (const o of e.outputs) {
        const pt = this.points(o, e.ind, candles, out[o.key] ?? [], i)[0];
        if (pt) o.series.update(pt as never);
      }
    }
  }

  /** Remove every series (chart is being torn down or the layer is reset). */
  clear(): void { for (const id of [...this.entries.keys()]) this.drop(id); }

  get paneCount(): number { return this.chart.panes().length; }

  private compute(ind: Indicator, candles: readonly Candle[]): Record<string, Series> {
    try { return computeIndicator(ind.type, candles, ind.params); } catch { return {}; }
  }

  private points(o: OutputSeries, ind: Indicator, candles: readonly Candle[], values: Series, only?: number) {
    const st = outputStyle(ind, o.key);
    const from = only ?? 0;
    const pts: Record<string, unknown>[] = [];
    for (let i = from; i < candles.length; i++) {
      const time = candles[i]!.time as UTCTimestamp;
      const v = values[i];
      if (!finite(v)) { pts.push({ time }); continue; }
      pts.push(o.kind === 'histogram' ? { time, value: v, color: v >= 0 ? st.color : st.negColor ?? st.color } : { time, value: v });
    }
    return pts;
  }

  private create(ind: Indicator, paneIndex: number, sig: string): Entry {
    const def = INDICATORS[ind.type];
    const title = indicatorTitle(ind);
    const outputs: OutputSeries[] = [];
    def.outputs.forEach((od, n) => {
      const st = outputStyle(ind, od.key);
      if (!st.visible) return;
      const common = { priceLineVisible: false, lastValueVisible: true, title: n === 0 ? title : od.label };
      let series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
      if (od.kind === 'histogram') {
        series = this.chart.addSeries(HistogramSeries, { ...common, color: st.color, priceFormat: { type: 'price', precision: 3, minMove: 0.001 }, base: 0 }, paneIndex);
      } else {
        series = this.chart.addSeries(LineSeries, {
          ...common, color: st.color, lineWidth: st.width as 1 | 2 | 3 | 4, lineStyle: LINE_STYLE[st.lineStyle], crosshairMarkerVisible: false,
          priceFormat: { type: 'price', precision: def.range ? 2 : 3, minMove: def.range ? 0.01 : 0.001 },
          ...(def.range ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range!.min, maxValue: def.range!.max } }) } : {}),
        }, paneIndex);
      }
      outputs.push({ key: od.key, kind: od.kind, series, lines: [] });
    });
    // Guide lines (RSI 30/70, Stochastic 20/80, MACD 0) hang off the first series of the pane.
    const first = outputs[0];
    if (first && def.placement === 'pane' && def.levels) {
      for (const price of def.levels) {
        first.lines.push(first.series.createPriceLine({ price, color: 'rgba(163,171,181,0.35)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' }));
      }
    }
    return { sig, ind, paneIndex, outputs };
  }

  private drop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (const o of e.outputs) {
      try { this.chart.removeSeries(o.series); } catch { /* chart already torn down */ }
    }
    this.entries.delete(id);
  }

  private layoutPanes(): void {
    try {
      const panes = this.chart.panes();
      panes.forEach((p, i) => p.setStretchFactor(i === 0 ? HIST_STRETCH : 1));
    } catch { /* chart already torn down */ }
  }
}
