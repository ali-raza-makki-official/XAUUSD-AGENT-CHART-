import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { TIMEFRAME_SECONDS, type Candle, type Point, type Proj, type Timeframe } from '@aurum/core';

/**
 * Converts between chart anchors (time, price) and pixels. Time goes through the bar index so drawings
 * stay aligned over weekend gaps and can extend into the empty area to the right of the last candle.
 */
export class ChartMapper {
  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<'Candlestick'>,
    public candles: Candle[],
    public tf: Timeframe,
    public pipSize: number,
  ) {}

  private get step() { return TIMEFRAME_SECONDS[this.tf]; }

  timeToLogical(time: number): number {
    const c = this.candles;
    if (!c.length) return 0;
    if (time <= c[0]!.time) return (time - c[0]!.time) / this.step;
    const last = c.length - 1;
    if (time >= c[last]!.time) return last + (time - c[last]!.time) / this.step;
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid]!.time <= time) lo = mid; else hi = mid;
    }
    const span = c[hi]!.time - c[lo]!.time;
    return lo + (span ? (time - c[lo]!.time) / span : 0);
  }

  logicalToTime(l: number): number {
    const c = this.candles;
    if (!c.length) return 0;
    const last = c.length - 1;
    if (l <= 0) return Math.round(c[0]!.time + l * this.step);
    if (l >= last) return Math.round(c[last]!.time + (l - last) * this.step);
    const i = Math.floor(l);
    return Math.round(c[i]!.time + (c[i + 1]!.time - c[i]!.time) * (l - i));
  }

  x(time: number): number {
    return this.chart.timeScale().logicalToCoordinate(this.timeToLogical(time) as never) ?? -1e6;
  }
  y(price: number): number {
    return this.series.priceToCoordinate(price) ?? -1e6;
  }
  timeAt(x: number): number {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return l === null ? 0 : this.logicalToTime(l);
  }
  priceAt(y: number): number {
    return this.series.coordinateToPrice(y) ?? 0;
  }

  /** Cursor pixel -> chart point, optionally snapped to the nearest candle price (magnet). */
  pointAt(x: number, y: number, magnet: boolean): Point {
    let time = this.timeAt(x);
    let price = this.priceAt(y);
    if (magnet && this.candles.length) {
      const l = this.chart.timeScale().coordinateToLogical(x);
      const i = l === null ? -1 : Math.round(l);
      const c = this.candles[i];
      if (c) {
        time = c.time;
        const best = [c.open, c.high, c.low, c.close].reduce((a, b) => (Math.abs(this.y(b) - y) < Math.abs(this.y(a) - y) ? b : a));
        if (Math.abs(this.y(best) - y) <= 14) price = best;
      }
    }
    return { time, price };
  }

  proj(width: number, height: number): Proj {
    return {
      x: (t) => this.x(t), y: (p) => this.y(p), t: (x) => this.timeAt(x), p: (y) => this.priceAt(y),
      width, height, pipSize: this.pipSize, tfSeconds: this.step,
    };
  }
}
