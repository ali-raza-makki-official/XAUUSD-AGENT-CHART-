import { Magnet, Pin, Redo2, Undo2 } from 'lucide-react';
import { TOOLS, type ToolId } from '../lib/tools';
import { TOOL_ICONS } from '../lib/toolIcons';
import { IconButton } from './ui';

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

const GROUPS: ToolId[][] = [
  ['cursor'],
  ['hline', 'vline', 'ray', 'trendline', 'channel'],
  ['zone', 'fib'],
  ['long', 'short', 'measure', 'text'],
];

export function Toolbar(p: Props) {
  return (
    <nav className="toolbar" aria-label="Drawing tools">
      {GROUPS.map((g, gi) => (
        <div key={gi} style={{ display: 'contents' }}>
          {gi > 0 && <span className="tgroup-sep" />}
          {g.map((id) => {
            const t = TOOLS.find((x) => x.id === id)!;
            return (
              <IconButton key={id} pos="right" label={t.label} tip={t.key ? `${t.label}  (${t.key})` : t.label} pressed={p.tool === id} onClick={() => p.onTool(id)}>
                {TOOL_ICONS[id]}
              </IconButton>
            );
          })}
        </div>
      ))}
      <span className="tgroup-sep" />
      <IconButton pos="right" label="Undo" tip="Undo  (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}><Undo2 size={18} strokeWidth={1.75} /></IconButton>
      <IconButton pos="right" label="Redo" tip="Redo  (Ctrl+Y)" disabled={!p.canRedo} onClick={p.onRedo}><Redo2 size={18} strokeWidth={1.75} /></IconButton>
      <span className="tgroup-sep" />
      <IconButton pos="right" label="Magnet" tip="Magnet: snap to candle open/high/low/close" pressed={p.magnet} onClick={p.onMagnet}><Magnet size={18} strokeWidth={1.75} /></IconButton>
      <IconButton pos="right" label="Stay in drawing mode" tip="Keep the tool selected after each drawing" pressed={p.stayInTool} onClick={p.onStay}><Pin size={18} strokeWidth={1.75} /></IconButton>
    </nav>
  );
}
