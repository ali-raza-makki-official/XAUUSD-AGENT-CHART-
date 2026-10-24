import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { applyTick, type Candle, type Tick, type Timeframe } from '@aurum/core';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const toBar = (c: Candle) => ({ ...c, time: c.time as UTCTimestamp });

interface Props { candles: Candle[]; tick: Tick | null; tf: Timeframe }

export function ChartView({ candles, tick, tf }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const bidLine = useRef<IPriceLine | null>(null);
  const last = useRef<Candle | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--bg-panel') }, textColor: css('--t2'), fontFamily: css('--font-mono'), fontSize: 12 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css('--border') },
      timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css('--buy'), downColor: css('--sell'),
      borderUpColor: css('--buy'), borderDownColor: css('--sell'),
      wickUpColor: css('--buy'), wickDownColor: css('--sell'),
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    chart.current = c;
    series.current = s;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      bidLine.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current) return;
    series.current.setData(candles.map(toBar));
    last.current = candles[candles.length - 1] ?? null;
    if (candles.length) chart.current?.timeScale().scrollToRealTime();
  }, [candles]);

  useEffect(() => {
    if (!tick || !series.current || !last.current) return;
    const next = applyTick([last.current], tick, tf);
    const bar = next[next.length - 1];
    if (bar && next !== undefined && (bar.time !== last.current.time || bar.close !== last.current.close || bar.high !== last.current.high || bar.low !== last.current.low)) {
      series.current.update(toBar(bar));
      last.current = bar;
    }
    if (bidLine.current) bidLine.current.applyOptions({ price: tick.bid });
    else bidLine.current = series.current.createPriceLine({ price: tick.bid, color: css('--t3'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'bid' });
  }, [tick, tf]);

  return <div className="chart" ref={host} />;
}
