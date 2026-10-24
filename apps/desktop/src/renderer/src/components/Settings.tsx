import { useState } from 'react';
import type { AppConfig } from '@aurum/core';
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
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={async () => { await onSave({ brokerSymbol: symbol.trim(), pipSize: pipNum }); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
