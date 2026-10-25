/** Lets the AI turn (which has no handle on React components) take a picture of the chart the user is looking at. */
interface Pane { active: () => boolean; snap: () => HTMLCanvasElement }
const panes = new Map<number, Pane>();

export function registerChartPane(id: number, pane: Pane): () => void {
  panes.set(id, pane);
  return () => { if (panes.get(id) === pane) panes.delete(id); };
}

const MAX_WIDTH = 1400;

/** PNG (base64) of the active chart pane with candles, indicators and drawings; null when no chart is mounted. */
export async function captureChart(): Promise<{ mime: string; data: string } | null> {
  const list = [...panes.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const pane = list.find((p) => p.active()) ?? list[0];
  if (!pane) return null;
  const src = pane.snap();
  if (!src.width || !src.height) return null;
  const scale = Math.min(1, MAX_WIDTH / src.width);
  let out = src;
  if (scale < 1) {
    out = document.createElement('canvas');
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    out.getContext('2d')?.drawImage(src, 0, 0, out.width, out.height);
  }
  const url = out.toDataURL('image/png');
  return { mime: 'image/png', data: url.slice(url.indexOf(',') + 1) };
}
