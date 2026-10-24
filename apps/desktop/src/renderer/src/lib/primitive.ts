import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { layoutDrawing, type Drawing, type Layout, type Shape } from '@aurum/core';
import type { ChartMapper } from './mapper';

export interface SceneItem { drawing: Drawing; selected: boolean; hovered: boolean }
export interface Scene { mapper: ChartMapper | null; items: SceneItem[]; tfLabel: string }

function paint(ctx: CanvasRenderingContext2D, s: Shape, bold: boolean) {
  switch (s.t) {
    case 'line':
      ctx.beginPath();
      ctx.setLineDash(s.dash);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width + (bold ? 1 : 0);
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      break;
    case 'rect':
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fillRect(s.x, s.y, s.w, s.h); }
      if (s.stroke) { ctx.setLineDash(s.dash ?? []); ctx.strokeStyle = s.stroke; ctx.lineWidth = (s.strokeWidth ?? 1) + (bold ? 1 : 0); ctx.strokeRect(s.x, s.y, s.w, s.h); }
      break;
    case 'poly':
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = s.fill;
      ctx.fill();
      break;
    case 'text': {
      ctx.font = `${s.size ?? 11}px 'JetBrains Mono', Consolas, monospace`;
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(s.text).width;
      const x = s.align === 'left' ? s.x : s.align === 'right' ? s.x - w : s.x - w / 2;
      if (s.bg) { ctx.fillStyle = s.bg; ctx.fillRect(x - 3, s.y - 8, w + 6, 16); }
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, x, s.y);
      break;
    }
  }
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly getScene: () => Scene) {}
  draw(target: CanvasRenderingTarget2D): void {
    const scene = this.getScene();
    if (!scene.mapper || !scene.items.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const proj = scene.mapper!.proj(mediaSize.width, mediaSize.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, mediaSize.width, mediaSize.height);
      ctx.clip();
      for (const it of scene.items) {
        const l: Layout = layoutDrawing(it.drawing, proj, scene.tfLabel);
        // Fills first so lines and labels stay readable on top.
        const order = (s: Shape) => (s.t === 'poly' || (s.t === 'rect' && !s.stroke) ? 0 : s.t === 'text' ? 2 : 1);
        [...l.shapes].sort((a, b) => order(a) - order(b)).forEach((s) => paint(ctx, s, it.selected || it.hovered));
        if (it.selected && !it.drawing.locked) {
          ctx.setLineDash([]);
          for (const h of l.handles) {
            ctx.fillStyle = '#14171b';
            ctx.strokeStyle = '#d4af5a';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.rect(h.x - 4, h.y - 4, 8, 8);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    });
  }
}

/** Series primitive that paints every visible drawing on the chart's own canvas, in sync with pan/zoom. */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private params: SeriesAttachedParameter<Time> | null = null;
  private readonly view: IPrimitivePaneView;
  constructor(private readonly getScene: () => Scene) {
    const renderer = new Renderer(getScene);
    this.view = { zOrder: () => 'top', renderer: () => renderer };
  }
  attached(p: SeriesAttachedParameter<Time>) { this.params = p; }
  detached() { this.params = null; }
  paneViews() { return [this.view]; }
  updateAllViews() {}
  requestUpdate() { this.params?.requestUpdate(); }
}
