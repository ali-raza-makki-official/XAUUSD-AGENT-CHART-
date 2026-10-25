import type { Drawing, Point } from './drawing';
import { rewardRisk } from './drawing';

/** Maps chart values to pixels and back. The renderer supplies the real chart; tests supply a linear one. */
export interface Proj {
  x(time: number): number;
  y(price: number): number;
  t(x: number): number;
  p(y: number): number;
  width: number;
  height: number;
  pipSize: number;
  tfSeconds: number;
}

export type Shape =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number; dash: number[] }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokeWidth?: number; dash?: number[] }
  | { t: 'poly'; pts: [number, number][]; fill: string }
  | { t: 'text'; x: number; y: number; text: string; color: string; align: 'left' | 'right' | 'center'; bg?: string; size?: number };

export interface Handle { key: string; x: number; y: number }
export type HitPrim =
  | { t: 'seg'; x1: number; y1: number; x2: number; y2: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number };

export interface Layout { shapes: Shape[]; handles: Handle[]; hit: HitPrim[] }

export const TRADE_BUY = '#2ebd85';
export const TRADE_SELL = '#f0616d';

const DASH = { solid: [] as number[], dashed: [6, 4], dotted: [2, 3] };

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const f2 = (n: number) => n.toFixed(2);
const sgn = (n: number) => (n >= 0 ? '+' : '−');

/** Extend the ray from (x1,y1) through (x2,y2) to the right edge (or left too). */
function extendLine(x1: number, y1: number, x2: number, y2: number, w: number, both: boolean): [number, number, number, number] {
  if (x1 === x2) return [x1, y1, x2, y2];
  const m = (y2 - y1) / (x2 - x1);
  const yAt = (x: number) => y1 + m * (x - x1);
  const ax = both ? Math.min(0, x1, x2) - 10 : x1;
  const bx = Math.max(w + 10, x2);
  const [sx, ex] = x1 <= x2 ? [ax, bx] : [bx, ax];
  return [both ? sx : x1, both ? yAt(sx) : y1, ex, yAt(ex)];
}

const segHit = (x1: number, y1: number, x2: number, y2: number): HitPrim => ({ t: 'seg', x1, y1, x2, y2 });

export function layoutDrawing(d: Drawing, p: Proj, tfLabel = ''): Layout {
  const L: Layout = { shapes: [], handles: [], hit: [] };
  const color = d.style.color;
  const dash = DASH[d.style.lineStyle];
  const tag = d.origin.by === 'ai' ? 'AI · ' : '';
  const line = (x1: number, y1: number, x2: number, y2: number, c = color, w = d.style.width, ds = dash, hit = true) => {
    L.shapes.push({ t: 'line', x1, y1, x2, y2, color: c, width: w, dash: ds });
    if (hit) L.hit.push(segHit(x1, y1, x2, y2));
  };
  const text = (x: number, y: number, s: string, align: 'left' | 'right' | 'center' = 'left', c = color) => {
    if (s) L.shapes.push({ t: 'text', x, y, text: s, color: c, align, bg: 'rgba(14,16,19,0.72)' });
  };
  const title = d.showLabel && (d.label || tag) ? `${tag}${d.label}`.trim() : '';

  switch (d.kind) {
    case 'hline': {
      const y = p.y(d.price);
      line(0, y, p.width, y);
      text(p.width - 6, y - 10, `${title ? title + '  ' : ''}${f2(d.price)}`, 'right');
      L.handles.push({ key: 'price', x: Math.max(40, p.width - 60), y });
      break;
    }
    case 'vline': {
      const x = p.x(d.time);
      line(x, 0, x, p.height);
      text(x + 4, 12, title);
      L.handles.push({ key: 'time', x, y: Math.min(60, p.height / 2) });
      break;
    }
    case 'ray': {
      const [x1, y1, x2, y2] = [p.x(d.a.time), p.y(d.a.price), p.x(d.b.time), p.y(d.b.price)];
      const e = extendLine(x1, y1, x2, y2, p.width, false);
      line(e[0], e[1], e[2], e[3]);
      text(x1 + 6, y1 - 8, title);
      L.handles.push({ key: 'a', x: x1, y: y1 }, { key: 'b', x: x2, y: y2 });
      break;
    }
    case 'trendline': {
      const [x1, y1, x2, y2] = [p.x(d.a.time), p.y(d.a.price), p.x(d.b.time), p.y(d.b.price)];
      const e = d.extend === 'none' ? [x1, y1, x2, y2] : extendLine(x1, y1, x2, y2, p.width, d.extend === 'both');
      line(e[0]!, e[1]!, e[2]!, e[3]!);
      text((x1 + x2) / 2, (y1 + y2) / 2 - 8, title, 'center');
      L.handles.push({ key: 'a', x: x1, y: y1 }, { key: 'b', x: x2, y: y2 });
      break;
    }
    case 'channel': {
      const [x1, y1, x2, y2] = [p.x(d.a.time), p.y(d.a.price), p.x(d.b.time), p.y(d.b.price)];
      const cx = p.x(d.c.time), cy = p.y(d.c.price);
      const m = x2 === x1 ? 0 : (y2 - y1) / (x2 - x1);
      const off = cy - (y1 + m * (cx - x1));
      line(x1, y1, x2, y2);
      line(x1, y1 + off, x2, y2 + off);
      line(x1, y1 + off / 2, x2, y2 + off / 2, color, 1, [4, 4], false);
      if (d.style.fillOpacity > 0) L.shapes.unshift({ t: 'poly', pts: [[x1, y1], [x2, y2], [x2, y2 + off], [x1, y1 + off]], fill: rgba(color, d.style.fillOpacity) });
      text(x1 + 6, y1 - 8, title);
      L.handles.push({ key: 'a', x: x1, y: y1 }, { key: 'b', x: x2, y: y2 }, { key: 'c', x: cx, y: cy });
      break;
    }
    case 'zone': {
      const xa = p.x(d.a.time), xb = d.extendRight ? Math.max(p.width, p.x(d.b.time)) : p.x(d.b.time);
      const ya = p.y(d.a.price), yb = p.y(d.b.price);
      const [x, y, w, h] = [Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya)];
      L.shapes.push({ t: 'rect', x, y, w, h, fill: rgba(color, d.style.fillOpacity), stroke: color, strokeWidth: d.style.width, dash });
      L.hit.push({ t: 'rect', x, y, w, h });
      const kind = d.zoneType === 'custom' ? '' : d.zoneType[0]!.toUpperCase() + d.zoneType.slice(1);
      // A zone that begins before the loaded history keeps its label at the left edge and says so, so it does not look glued there by a bug.
      const before = x < 0;
      text(Math.max(x, 0) + 6, y + 12, `${before ? '◂ ' : ''}${[tag + kind, d.label].filter(Boolean).join(' · ').replace(/^AI · $/, 'AI')}`);
      L.handles.push({ key: 'a', x: p.x(d.a.time), y: ya }, { key: 'b', x: p.x(d.b.time), y: yb });
      break;
    }
    case 'fib': {
      const xa = p.x(d.a.time), xb = p.x(d.b.time);
      const x0 = Math.min(xa, xb), x1 = d.extendRight ? Math.max(p.width, Math.max(xa, xb)) : Math.max(xa, xb);
      const priceAt = (r: number) => d.b.price + (d.a.price - d.b.price) * r;
      const vis = d.levels.filter((l) => l.visible).sort((a, b) => a.ratio - b.ratio);
      vis.forEach((l, i) => {
        const y = p.y(priceAt(l.ratio));
        const c = l.color ?? color;
        line(x0, y, x1, y, c, d.style.width, DASH.solid);
        text(x0 + 4, y - 8, `${l.ratio} (${f2(priceAt(l.ratio))})`, 'left', c);
        const next = vis[i + 1];
        if (next && d.style.fillOpacity > 0 && i % 2 === 0) {
          const yn = p.y(priceAt(next.ratio));
          L.shapes.unshift({ t: 'rect', x: x0, y: Math.min(y, yn), w: x1 - x0, h: Math.abs(yn - y), fill: rgba(c, d.style.fillOpacity) });
        }
      });
      line(xa, p.y(d.a.price), xb, p.y(d.b.price), '#7d8590', 1, [4, 4]);
      text(x0 + 4, p.y(priceAt(0)) + 14, title);
      L.handles.push({ key: 'a', x: xa, y: p.y(d.a.price) }, { key: 'b', x: xb, y: p.y(d.b.price) });
      break;
    }
    case 'measure': {
      const [x1, y1, x2, y2] = [p.x(d.a.time), p.y(d.a.price), p.x(d.b.time), p.y(d.b.price)];
      const dp = d.b.price - d.a.price;
      const bars = Math.round((d.b.time - d.a.time) / p.tfSeconds);
      const pct = d.a.price ? (dp / d.a.price) * 100 : 0;
      const up = dp >= 0;
      const c = up ? TRADE_BUY : TRADE_SELL;
      L.shapes.push({ t: 'rect', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), fill: rgba(c, d.style.fillOpacity), stroke: rgba(c, 0.6), dash });
      L.hit.push({ t: 'rect', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
      line(x1, y1, x2, y2, c, 1, [], false);
      text((x1 + x2) / 2, Math.min(y1, y2) - 8, `${sgn(dp)}${f2(Math.abs(dp))} (${Math.abs(dp / p.pipSize).toFixed(0)} pips, ${sgn(pct)}${Math.abs(pct).toFixed(2)}%) · ${Math.abs(bars)} bars ${tfLabel}`.trim(), 'center', c);
      L.handles.push({ key: 'a', x: x1, y: y1 }, { key: 'b', x: x2, y: y2 });
      break;
    }
    case 'text': {
      const x = p.x(d.at.time), y = p.y(d.at.price);
      text(x, y, `${tag}${d.text}`.trim(), 'left', color);
      L.hit.push({ t: 'rect', x: x - 2, y: y - 14, w: Math.max(60, d.text.length * 7), h: 20 });
      L.handles.push({ key: 'at', x, y });
      break;
    }
    case 'position': {
      const x0 = p.x(d.entryTime), x1 = Math.min(p.width - 8, x0 + 280);
      const yE = p.y(d.entry), yS = p.y(d.stopLoss);
      const tps = d.takeProfits.map((t) => ({ ...t, y: p.y(t.price) }));
      const farY = tps.length ? tps.reduce((a, b) => (Math.abs(b.y - yE) > Math.abs(a - yE) ? b.y : a), yE) : yE;
      const fo = d.style.fillOpacity;
      L.shapes.push({ t: 'rect', x: x0, y: Math.min(yE, yS), w: x1 - x0, h: Math.abs(yS - yE), fill: rgba(TRADE_SELL, fo) });
      if (tps.length) L.shapes.push({ t: 'rect', x: x0, y: Math.min(yE, farY), w: x1 - x0, h: Math.abs(farY - yE), fill: rgba(TRADE_BUY, fo) });
      L.hit.push({ t: 'rect', x: x0, y: Math.min(yE, yS, farY), w: x1 - x0, h: Math.abs(Math.max(yE, yS, farY) - Math.min(yE, yS, farY)) });
      const risk = Math.abs(d.entry - d.stopLoss);
      line(x0, yE, x1, yE, color, 1.5, [], false);
      text(x0 + 4, yE - 10, `${d.side.toUpperCase()} ${f2(d.entry)}${title ? ' · ' + title : ''}`, 'left', '#e6e9ed');
      line(x0, yS, x1, yS, TRADE_SELL, 1.5, [], false);
      text(x1 - 4, yS + (d.side === 'buy' ? 10 : -10), `SL ${f2(d.stopLoss)} · ${sgn(-risk)}${f2(risk)} · ${(risk / p.pipSize).toFixed(0)} pips`, 'right', TRADE_SELL);
      tps.forEach((t, i) => {
        line(x0, t.y, x1, t.y, TRADE_BUY, 1.5, [], false);
        const dist = Math.abs(t.price - d.entry);
        text(x1 - 4, t.y + (d.side === 'buy' ? -10 : 10), `TP${i + 1} ${f2(t.price)} · ${(dist / p.pipSize).toFixed(0)} pips · ${rewardRisk(d, t.price).toFixed(1)}R · ${t.closePct}%`, 'right', TRADE_BUY);
        L.handles.push({ key: `tp${i}`, x: x1, y: t.y });
      });
      L.handles.push({ key: 'entry', x: x0, y: yE }, { key: 'sl', x: x1, y: yS });
      break;
    }
  }
  return L;
}

export function pointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Distance in px from the cursor to the drawing (0 if inside a filled shape). Infinity if far. */
export function hitDistance(l: Layout, px: number, py: number): number {
  let best = Infinity;
  for (const h of l.hit) {
    if (h.t === 'seg') best = Math.min(best, pointToSegment(px, py, h.x1, h.y1, h.x2, h.y2));
    else if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) best = Math.min(best, 0.5);
  }
  return best;
}

export function handleAt(l: Layout, px: number, py: number, r = 8): Handle | undefined {
  return l.handles.find((h) => Math.hypot(h.x - px, h.y - py) <= r);
}

const shift = (pt: Point, dt: number, dp: number): Point => ({ time: pt.time + dt, price: pt.price + dp });

/** Patch that moves the whole drawing by (dt, dp). */
export function translatePatch(d: Drawing, dt: number, dp: number): Record<string, unknown> {
  switch (d.kind) {
    case 'hline': return { price: d.price + dp };
    case 'vline': return { time: d.time + dt };
    case 'ray': case 'trendline': case 'zone': case 'fib': case 'measure': return { a: shift(d.a, dt, dp), b: shift(d.b, dt, dp) };
    case 'channel': return { a: shift(d.a, dt, dp), b: shift(d.b, dt, dp), c: shift(d.c, dt, dp) };
    case 'text': return { at: shift(d.at, dt, dp) };
    case 'position':
      return { entryTime: d.entryTime + dt, entry: d.entry + dp, stopLoss: d.stopLoss + dp, takeProfits: d.takeProfits.map((t) => ({ ...t, price: t.price + dp })) };
  }
}

/** Patch that moves one handle to a new chart position. */
export function handlePatch(d: Drawing, key: string, time: number, price: number): Record<string, unknown> {
  if (d.kind === 'hline') return { price };
  if (d.kind === 'vline') return { time };
  if (d.kind === 'position') {
    if (key === 'entry') return { entry: price, entryTime: time };
    if (key === 'sl') return { stopLoss: price };
    const m = /^tp(\d)$/.exec(key);
    if (m) return { takeProfits: d.takeProfits.map((t, i) => (i === Number(m[1]) ? { ...t, price } : t)) };
    return {};
  }
  return { [key]: { time, price } };
}
