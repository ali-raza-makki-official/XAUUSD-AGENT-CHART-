import { useState } from 'react';
import { DEFAULT_STYLES, DRAWING_KINDS, type AppConfig, type DrawingKind, type Style } from '@aurum/core';
import type { AurumApi } from '../../../shared';

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

  const find = async () => {
    setErr(null);
    try { setFound(await api.findSymbols('XAU,GOLD')); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const pipNum = Number(pip);
  const valid = symbol.trim().length > 0 && pipNum > 0;

  return (
    <div className="dialog-back" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="dialog">
        <h3>Settings</h3>
        <div className="field">
          <label htmlFor="sym">Broker symbol for gold</label>
          <input id="sym" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          <span className="hint">Exness: whatever your terminal calls gold (e.g. GOLD, XAUUSD, XAUUSDm).</span>
          <div className="row">
            <button className="btn" onClick={find}>Find gold symbols in MT5</button>
            {found?.map((s) => (<button key={s} className="btn" onClick={() => setSymbol(s)}>{s}</button>))}
            {found && found.length === 0 && <span className="hint">None found.</span>}
          </div>
          {err && <span className="hint" style={{ color: 'var(--warn)' }}>{err}</span>}
        </div>
        <div className="field">
          <label htmlFor="pip">Pip size (price units)</label>
          <input id="pip" className="mono" value={pip} onChange={(e) => setPip(e.target.value)} />
          <span className="hint">Gold is usually 0.10, so 50–100 pips = 5–10 in price. Confirm against your broker.</span>
        </div>
        <div className="field">
          <label>Default style for new drawings</label>
          <div className="scroll">
            <table>
              <thead><tr><th>Tool</th><th>Colour</th><th>Width</th><th>Line</th><th>Fill</th></tr></thead>
              <tbody>
                {DRAWING_KINDS.map((k) => (
                  <tr key={k}>
                    <td style={{ textTransform: 'capitalize' }}>{k}</td>
                    <td><input type="color" aria-label={`${k} colour`} value={styles[k]!.color} onChange={(e) => setStyle(k, { color: e.target.value })} /></td>
                    <td><input type="number" min={1} max={8} aria-label={`${k} width`} value={styles[k]!.width} onChange={(e) => setStyle(k, { width: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} /></td>
                    <td><select aria-label={`${k} line style`} value={styles[k]!.lineStyle} onChange={(e) => setStyle(k, { lineStyle: e.target.value as Style['lineStyle'] })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></td>
                    <td><input type="number" step={0.02} min={0} max={1} aria-label={`${k} fill`} value={styles[k]!.fillOpacity} onChange={(e) => setStyle(k, { fillOpacity: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="hint">Applies to drawings you create from now on. Existing drawings keep their own style.</span>
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={async () => { await onSave({ brokerSymbol: symbol.trim(), pipSize: pipNum, toolStyles: styles }); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
