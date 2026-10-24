import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { DEFAULT_STYLES, DRAWING_KINDS, type AppConfig, type DrawingKind, type Style } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, Chip, IconButton, Segmented } from './ui';
import { ConnectorsSettings } from './ConnectorsSettings';

interface Props {
  api: AurumApi;
  config: AppConfig;
  onSave: (patch: Partial<AppConfig>) => Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({ api, config, onSave, onClose }: Props) {
  const [symbol, setSymbol] = useState(config.brokerSymbol);
  const [pip, setPip] = useState(String(config.pipSize));
  const [found, setFound] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [styles, setStyles] = useState<Record<string, Style>>(() =>
    Object.fromEntries(DRAWING_KINDS.map((k) => [k, { ...DEFAULT_STYLES[k], ...config.toolStyles[k] }])),
  );
  const setStyle = (k: DrawingKind, s: Partial<Style>) => setStyles((cur) => ({ ...cur, [k]: { ...cur[k]!, ...s } }));

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const find = async () => {
    setErr(null);
    try { setFound(await api.findSymbols('XAU,GOLD')); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const pipNum = Number(pip);
  const valid = symbol.trim().length > 0 && pipNum > 0;

  return (
    <div className="dialog-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="dialog-h"><h3>Settings</h3><IconButton label="Close settings" onClick={onClose}><X size={16} /></IconButton></div>
        <div className="dialog-b">
          <div className="field">
            <label htmlFor="sym">Broker symbol for gold</label>
            <input id="sym" className="input mono" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            <div className="row">
              <Button size="sm" icon={Search} onClick={find}>Find gold symbols in MT5</Button>
              {found?.map((s) => (<Button key={s} size="sm" onClick={() => setSymbol(s)}>{s}</Button>))}
              {found && found.length === 0 && <span className="hint">None found.</span>}
            </div>
            <span className="hint">Use the name your terminal shows for gold (for example GOLD, XAUUSD or XAUUSDm).</span>
            {err && <Chip tone="warn">{err}</Chip>}
          </div>
          <div className="field">
            <label htmlFor="pip">Pip size (price units)</label>
            <input id="pip" className="input mono" style={{ maxWidth: 140 }} value={pip} onChange={(e) => setPip(e.target.value)} />
            <span className="hint">Gold is usually 0.10, so 50–100 pips is 5–10 in price. Confirm against your broker.</span>
          </div>
          <div className="field">
            <span className="lbl">Default style for new drawings</span>
            <div className="scroll">
              <table className="dtable">
                <thead><tr><th>Tool</th><th>Colour</th><th>Width</th><th>Line</th><th>Fill</th></tr></thead>
                <tbody>
                  {DRAWING_KINDS.map((k) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td><input type="color" aria-label={`${k} colour`} value={styles[k]!.color} onChange={(e) => setStyle(k, { color: e.target.value })} /></td>
                      <td><input className="input mono" type="number" min={1} max={8} aria-label={`${k} width`} value={styles[k]!.width} onChange={(e) => setStyle(k, { width: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} /></td>
                      <td><Segmented<Style['lineStyle']> label={`${k} line style`} size="sm" value={styles[k]!.lineStyle} onChange={(v) => setStyle(k, { lineStyle: v })} options={[{ value: 'solid', label: '—' , title: 'Solid' }, { value: 'dashed', label: '- -', title: 'Dashed' }, { value: 'dotted', label: '···', title: 'Dotted' }]} /></td>
                      <td><input className="input mono" type="number" step={0.02} min={0} max={1} aria-label={`${k} fill`} value={styles[k]!.fillOpacity} onChange={(e) => setStyle(k, { fillOpacity: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="hint">Applies to drawings you create from now on. Existing drawings keep their own style.</span>
          </div>
          <ConnectorsSettings api={api} config={config} onSave={onSave} />
        </div>
        <div className="dialog-f">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={async () => { await onSave({ brokerSymbol: symbol.trim(), pipSize: pipNum, toolStyles: styles }); onClose(); }}>Save</Button>
        </div>
      </div>
    </div>
  );
}
