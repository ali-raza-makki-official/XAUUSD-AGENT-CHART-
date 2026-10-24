import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, KeyRound, ListRestart, LoaderCircle, Lock, Search, X, Zap } from 'lucide-react';
import {
  DEFAULT_STYLES, DRAWING_KINDS, PROVIDERS, PROVIDER_IDS,
  type AiPermissions, type AiSettings, type AppConfig, type DrawingKind, type ProviderId, type Style,
} from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, Chip, IconButton, Section, Segmented, Switch } from './ui';
import { ConnectorsSettings } from './ConnectorsSettings';

interface Props {
  api: AurumApi;
  config: AppConfig;
  onSave: (patch: Partial<AppConfig>) => Promise<void>;
  onClose: () => void;
  initialTab?: TabId;
}

export type TabId = 'general' | 'styles' | 'ai' | 'connectors';

function AiTab({ api, config, onSave }: { api: AurumApi; config: AppConfig; onSave: Props['onSave'] }) {
  const [ai, setAi] = useState<AiSettings>(config.ai);
  const [perms, setPerms] = useState<AiPermissions>(config.aiPermissions);
  const [status, setStatus] = useState<{ secureStorage: boolean; hasKey: Record<ProviderId, boolean> } | null>(null);
  const [keyText, setKeyText] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const provider = ai.provider;
  const adapter = provider ? PROVIDERS[provider] : null;
  const refresh = useCallback(() => api.aiStatus().then(setStatus), [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setModels([]); setMsg(null); setKeyText(''); }, [provider]);

  const patchAi = (p: Partial<AiSettings>) => setAi((cur) => ({ ...cur, ...p }));
  const setPerm = <K extends keyof AiPermissions>(k: K, v: AiPermissions[K]) => setPerms((cur) => ({ ...cur, [k]: v }));
  const persist = async () => { await onSave({ ai, aiPermissions: perms }); };

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }); } finally { setBusy(null); }
  };

  const saveKey = () => run('key', async () => {
    await api.aiSetKey(provider!, keyText.trim());
    setKeyText('');
    await refresh();
    setMsg({ ok: true, text: 'Key saved (encrypted on this PC).' });
  });
  const removeKey = () => run('key', async () => { await api.aiClearKey(provider!); await refresh(); setMsg({ ok: true, text: 'Key removed.' }); });
  const loadModels = () => run('models', async () => { await persist(); const m = await api.aiListModels(provider!); setModels(m); setMsg({ ok: true, text: `${m.length} models available for this key.` }); });
  const test = () => run('test', async () => { await persist(); const r = await api.aiTest(provider!); setMsg({ ok: true, text: `Connected in ${r.ms} ms. The model replied: "${r.reply.trim()}"` }); });

  const hasKey = provider ? status?.hasKey[provider] : false;

  return (
    <>
      <Section title="Provider">
        <Segmented<ProviderId> label="AI provider" value={provider ?? 'anthropic'} onChange={(v) => patchAi({ provider: v })} options={PROVIDER_IDS.map((p) => ({ value: p, label: PROVIDERS[p].label.replace(/ \(.*\)/, '') }))} />
        {!provider && <span className="hint">Pick a provider to continue. You can switch any time; each provider keeps its own key and model.</span>}
        {provider && adapter && (
          <>
            <div className="field">
              <label htmlFor="key">API key {hasKey ? <Chip tone="ok" icon={CircleCheck}>Saved</Chip> : <Chip tone="warn">Not set</Chip>}</label>
              <div className="row">
                <input id="key" type="password" className="input mono" style={{ flex: 1 }} autoComplete="off" spellCheck={false} placeholder={hasKey ? '•••••••••• (saved, enter a new one to replace)' : 'Paste your API key'} value={keyText} onChange={(e) => setKeyText(e.target.value)} />
                <Button variant="primary" icon={KeyRound} disabled={keyText.trim().length < 8 || busy !== null || status?.secureStorage === false} onClick={saveKey}>Save key</Button>
                {hasKey && <Button variant="danger" onClick={removeKey} disabled={busy !== null}>Remove</Button>}
              </div>
              <span className="hint">Stored encrypted by the operating system and used only by the app's background process. It is never shown again, never sent to the chart UI, and never written to logs.</span>
              {status?.secureStorage === false && <Chip tone="danger">Secure storage is unavailable on this system, so keys cannot be saved.</Chip>}
            </div>
            <div className="field">
              <label htmlFor="model">Model</label>
              <div className="row">
                <input id="model" list="models" className="input mono" style={{ flex: 1 }} placeholder={adapter.suggestedModel || 'Click “Load models” and pick one'} value={ai.models[provider] ?? ''} onChange={(e) => patchAi({ models: { ...ai.models, [provider]: e.target.value } })} />
                <datalist id="models">{models.map((m) => <option key={m} value={m} />)}</datalist>
                <Button icon={ListRestart} disabled={!hasKey || busy !== null} onClick={loadModels}>{busy === 'models' ? 'Loading…' : 'Load models'}</Button>
              </div>
              <span className="hint">Model names differ by account and change over time, so load the real list from the provider instead of guessing.</span>
            </div>
            <details>
              <summary className="hint" style={{ cursor: 'pointer' }}>Advanced: custom base URL</summary>
              <div className="field" style={{ marginTop: 8 }}>
                <input className="input mono" placeholder={adapter.defaultBaseUrl} aria-label="Base URL" value={ai.baseUrls[provider] ?? ''} onChange={(e) => patchAi({ baseUrls: { ...ai.baseUrls, [provider]: e.target.value } })} />
                <span className="hint">For a proxy or an OpenAI-compatible gateway. https is required, except localhost.</span>
              </div>
            </details>
            <div className="row">
              <Button icon={Zap} disabled={!hasKey || busy !== null || !(ai.models[provider] || adapter.suggestedModel)} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
              {busy && <LoaderCircle size={14} className="spin" />}
            </div>
            {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-warn'}`} role="status">{msg.ok ? <CircleCheck size={14} /> : <CircleX size={14} />}<span>{msg.text}</span></div>}
          </>
        )}
      </Section>

      <Section title="What the AI may do">
        <div className="perm"><div><b>Read chart and analyse</b><span className="hint">Candles, drawings, quotes, risk maths</span></div><Switch label="Chart read" checked={perms.chartRead} onChange={(v) => setPerm('chartRead', v)} /></div>
        <div className="perm"><div><b>Draw and edit on the chart</b><span className="hint">Its own layer; locked drawings stay untouchable; every change is undoable</span></div><Switch label="Drawings edit" checked={perms.drawingsEdit} onChange={(v) => setPerm('drawingsEdit', v)} /></div>
        <div className="perm"><div><b>Indicators</b><span className="hint">Add, change and remove indicators on the chart</span></div><Switch label="Indicators edit" checked={perms.indicatorsEdit} onChange={(v) => setPerm('indicatorsEdit', v)} /></div>
        <div className="perm"><div><b>Chart layout and timeframes</b><span className="hint">View only: switch layouts and pane timeframes</span></div><Switch label="Chart control" checked={perms.chartControl} onChange={(v) => setPerm('chartControl', v)} /></div>
        <div className="perm off"><div><b>Create alerts and setups</b><span className="hint">Coming with the alerts module</span></div><Switch label="Alerts and setups" checked={false} onChange={() => undefined} disabled /></div>
        <div className="perm off"><div><b>Place orders, edit SL/TP, partial and bulk close</b><span className="hint">Not enabled yet. The AI can only suggest; it cannot touch real orders.</span></div><Lock size={14} aria-hidden="true" /></div>
        <div className="perm off"><div><b>Connectors and credentials</b><span className="hint">Never available to the AI</span></div><Lock size={14} aria-hidden="true" /></div>
      </Section>

      <Section title="Privacy">
        <div className="perm"><div><b>Share account balance with the AI provider</b><span className="hint">Off: lot sizes are still calculated on this PC, but balance and money amounts are not sent. Chart prices and your drawings are sent when the AI reads them.</span></div><Switch label="Share account balance" checked={ai.sendBalance} onChange={(v) => patchAi({ sendBalance: v })} /></div>
      </Section>
      <div><Button variant="primary" onClick={() => void run('save', async () => { await persist(); setMsg({ ok: true, text: 'AI settings saved.' }); })} disabled={busy !== null}>Save AI settings</Button></div>
    </>
  );
}

export function SettingsDialog({ api, config, onSave, onClose, initialTab = 'general' }: Props) {
  const [tab, setTab] = useState<TabId>(initialTab);
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
        <div className="dialog-h">
          <h3>Settings</h3>
          <Segmented<TabId> label="Settings section" size="sm" value={tab} onChange={setTab} options={[{ value: 'general', label: 'General' }, { value: 'styles', label: 'Drawing styles' }, { value: 'ai', label: 'AI' }, { value: 'connectors', label: 'Connectors' }]} />
          <IconButton label="Close settings" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="dialog-b">
          {tab === 'general' && (
            <>
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
            </>
          )}
          {tab === 'styles' && (
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
                        <td><Segmented<Style['lineStyle']> label={`${k} line style`} size="sm" value={styles[k]!.lineStyle} onChange={(v) => setStyle(k, { lineStyle: v })} options={[{ value: 'solid', label: '—', title: 'Solid' }, { value: 'dashed', label: '- -', title: 'Dashed' }, { value: 'dotted', label: '···', title: 'Dotted' }]} /></td>
                        <td><input className="input mono" type="number" step={0.02} min={0} max={1} aria-label={`${k} fill`} value={styles[k]!.fillOpacity} onChange={(e) => setStyle(k, { fillOpacity: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span className="hint">Applies to drawings you create from now on. Existing drawings keep their own style.</span>
            </div>
          )}
          {tab === 'ai' && <AiTab api={api} config={config} onSave={onSave} />}
          {tab === 'connectors' && <ConnectorsSettings api={api} config={config} onSave={onSave} />}
        </div>
        <div className="dialog-f">
          <Button onClick={onClose}>{tab === 'ai' || tab === 'connectors' ? 'Close' : 'Cancel'}</Button>
          {tab !== 'ai' && tab !== 'connectors' && <Button variant="primary" disabled={!valid} onClick={async () => { await onSave({ brokerSymbol: symbol.trim(), pipSize: pipNum, toolStyles: styles }); onClose(); }}>Save</Button>}
        </div>
      </div>
    </div>
  );
}
