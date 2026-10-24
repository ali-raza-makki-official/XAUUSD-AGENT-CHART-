import { TOOLS, type ToolId } from '../lib/tools';

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

interface Props {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  magnet: boolean;
  onMagnet: () => void;
  stayInTool: boolean;
  onStay: () => void;
}

export function Toolbar(p: Props) {
  return (
    <nav className="toolbar" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button key={t.id} className="tool" aria-pressed={p.tool === t.id} aria-label={t.label} title={`${t.label}${t.key ? ` (${t.key})` : ''}`} onClick={() => p.onTool(t.id)}>
          <Icon d={t.icon} />
        </button>
      ))}
      <span className="tool-sep" />
      <button className="tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}><Icon d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" /></button>
      <button className="tool" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!p.canRedo} onClick={p.onRedo}><Icon d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" /></button>
      <span className="tool-sep" />
      <button className="tool" aria-pressed={p.magnet} aria-label="Magnet: snap to candle prices" title="Magnet: snap to candle open/high/low/close" onClick={p.onMagnet}><Icon d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z" /></button>
      <button className="tool" aria-pressed={p.stayInTool} aria-label="Stay in drawing mode" title="Stay in drawing mode after each drawing" onClick={p.onStay}><Icon d="M12 3v4M12 17v4M3 12h4M17 12h4M12 12h.01" /></button>
    </nav>
  );
}
