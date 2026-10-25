import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, KeyRound, ListRestart, LoaderCircle, Lock, Search, X, Zap } from 'lucide-react';
import {
  DEFAULT_STYLES, DRAWING_KINDS, PROVIDERS, PROVIDER_IDS,
  type AiPermissions, type AiSettings, type AppConfig, type DrawingKind, type ProviderId, type Style,
} from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, Chip, IconButton, Section, Segmented, Switch } from './ui';
import { ConnectorsSettings } from './ConnectorsSettings';
import { NotificationSettings } from './AlertsPanel';
import { WhatsAppSettings } from './WhatsAppSettings';

interface Props {
  api: AurumApi;
  config: AppConfig;
  onSave: (patch: Partial<AppConfig>) => Promise<void>;
  onClose: () => void;
  initialTab?: TabId;
}

export type TabId = 'general' | 'styles' | 'ai' | 'connectors' | 'whatsapp' | 'trading';

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
        <div className="perm"><div><b>Create alerts and setups</b><span className="hint">Alerts are checked by code on the live feed, not by the AI. Every change is undoable; the AI can keep at most 50 alerts.</span></div><Switch label="Alerts and setups" checked={perms.alertsAndSetups} onChange={(v) => setPerm('alertsAndSetups', v)} /></div>
        <div className="perm"><div><b>Orders by the AI</b><span className="hint">Suggest: the AI cannot prepare orders. Confirm: the AI may prepare an order preview; nothing is sent until YOU press Confirm, and the risk rules run again then. Needs Settings &gt; Trading enabled (demo).</span></div>
          <Segmented<'suggest' | 'confirm'> label="AI order mode" size="sm" value={perms.orders === 'confirm' ? 'confirm' : 'suggest'} onChange={(v) => { if (v === 'confirm' && !config.trading.enabled) return; setPerm('orders', v); }} options={[{ value: 'suggest', label: 'Suggest' }, { value: 'confirm', label: 'Confirm', title: config.trading.enabled ? 'The AI may prepare previews you confirm' : 'Enable trading first (Trading section)' }]} /></div>
        <div className="perm"><div><b>AI may propose SL/TP changes and partial closes</b><span className="hint">Each one still needs your Confirm click.</span></div><Switch label="SL TP and partial close" checked={perms.sltpAndPartialClose} onChange={(v) => setPerm('sltpAndPartialClose', v)} /></div>
        <div className="perm off"><div><b>Bulk close</b><span className="hint">Never available to the AI in this version</span></div><Lock size={14} aria-hidden="true" /></div>
        <div className="perm off"><div><b>Connectors and credentials</b><span className="hint">Never available to the AI</span></div><Lock size={14} aria-hidden="true" /></div>
      </Section>

      <Section title="Privacy">
        <div className="perm"><div><b>Share account balance with the AI provider</b><span className="hint">Off: lot sizes are still calculated on this PC, but balance and money amounts are not sent. Chart prices and your drawings are sent when the AI reads them.</span></div><Switch label="Share account balance" checked={ai.sendBalance} onChange={(v) => patchAi({ sendBalance: v })} /></div>
      </Section>
      <div><Button variant="primary" onClick={() => void run('save', async () => { await persist(); setMsg({ ok: true, text: 'AI settings saved.' }); })} disabled={busy !== null}>Save AI settings</Button></div>
    </>
  );
}

function TradingTab({ config, onSave }: { config: AppConfig; onSave: Props['onSave'] }) {
  const [enabled, setEnabled] = useState(config.trading.enabled);
  const [risk, setRisk] = useState(config.risk);
  const [msg, setMsg] = useState<string | null>(null);
  const num = (k: keyof typeof risk, label: string, step = 0.1) => (
    <div className="irow" key={String(k)}>
      <span className="ilabel">{label}</span>
      <input className="input mono" type="number" step={step} min={0} value={Number(risk[k])} aria-label={label} onChange={(e) => setRisk({ ...risk, [k]: Number(e.target.value) })} />
    </div>
  );
  return (
    <>
      <Section title="Order placement">
        <div className="perm"><div><b>Enable trading from Aurum (demo accounts only)</b><span className="hint">Starts the MT5 bridge with order endpoints. Aurum refuses live accounts. Every order still needs your Confirm click.</span></div><Switch label="Enable trading" checked={enabled} onChange={setEnabled} /></div>
        <Chip tone="warn">Test on an Exness DEMO account first. See docs/ORDERS.md.</Chip>
      </Section>
      <Section title="Risk limits (checked by code before every order)">
        {num('maxRiskPerTradePct', 'Max risk per trade (% of balance)')}
        {num('maxOpenRiskPct', 'Max total open risk (%)')}
        {num('maxDailyLossPct', 'Max daily loss (%)')}
        {num('maxSpread', 'Max spread (price)', 0.05)}
        {num('maxSlippage', 'Max slippage (price)', 0.05)}
        {num('maxSimultaneousPositions', 'Max open positions', 1)}
        <div className="irow"><span className="ilabel">After daily limit</span>
          <Segmented<'manage_only' | 'freeze'> label="Daily limit policy" size="sm" value={risk.dailyLimitPolicy === 'freeze' ? 'freeze' : 'manage_only'} onChange={(v) => setRisk({ ...risk, dailyLimitPolicy: v })} options={[{ value: 'manage_only', label: 'Manage only' }, { value: 'freeze', label: 'Freeze' }]} />
        </div>
        <span className="hint">Manage only: no new risk, but you can move SL toward safety and close or reduce. A stop loss is always required.</span>
      </Section>
      <div><Button variant="primary" onClick={() => void onSave({ trading: { enabled }, risk }).then(() => setMsg('Saved. The MT5 bridge restarts when you change the trading switch.'))}>Save trading settings</Button> {msg && <span className="hint">{msg}</span>}</div>
    </>
  );
}

export function SettingsDialog({ api, config, onSave, onClose, initialTab = 'general' }: Props) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [symbol, setSymbol] = useState(config.brokerSymbol);
  const [pip, setPip] = useState(String(config.pipSize));
  const [mt5Path, setMt5Path] = useState(config.mt5Path);
  const [mode, setMode] = useState<'python' | 'ea'>(config.mt5Mode);
  const [copied, setCopied] = useState(false);
  const [ea, setEa] = useState<{ port: number; token: string; connected: boolean } | null>(null);
  useEffect(() => { if (mode === 'ea') void api.eaInfo().then(setEa).catch(() => setEa(null)); }, [mode, api]);
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
    <div className="dialog-back page" role="presentation">
      <div className="dialog page" role="dialog" aria-label="Settings">
        <div className="dialog-h">
          <h3>Settings</h3>
          <IconButton label="Back to chart (Esc)" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <button type="button" className="settings-nav-item" aria-current={tab === 'general' ? 'page' : undefined} onClick={() => setTab('general')}>General</button>
            <button type="button" className="settings-nav-item" aria-current={tab === 'styles' ? 'page' : undefined} onClick={() => setTab('styles')}>Drawing styles</button>
            <button type="button" className="settings-nav-item" aria-current={tab === 'ai' ? 'page' : undefined} onClick={() => setTab('ai')}>AI</button>
            <button type="button" className="settings-nav-item" aria-current={tab === 'trading' ? 'page' : undefined} onClick={() => setTab('trading')}>Trading</button>
            <button type="button" className="settings-nav-item" aria-current={tab === 'connectors' ? 'page' : undefined} onClick={() => setTab('connectors')}>Connectors</button>
            <button type="button" className="settings-nav-item" aria-current={tab === 'whatsapp' ? 'page' : undefined} onClick={() => setTab('whatsapp')}>WhatsApp</button>
          </nav>
          <div className="dialog-b settings-pane">
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
                <label>How Aurum connects to MT5</label>
                <Segmented<'python' | 'ea'> label="MT5 connection" size="sm" value={mode} onChange={setMode} options={[{ value: 'python', label: 'Python bridge (tested)' }, { value: 'ea', label: 'EA bridge (new, untested)' }]} />
                {mode === 'ea' && (
                  <div className="calc mono">
                    <div>In MT5: compile and attach <b>AurumBridge.mq5</b> (bridge/mql5) to any chart, tick "Allow algorithmic trading", and add http://127.0.0.1 under Tools &gt; Options &gt; Expert Advisors.</div>
                    <div>HubHost 127.0.0.1 · HubPort {ea?.port ?? '…'}</div>
                    <div className="row" style={{ gap: 8 }}>AuthToken <b style={{ userSelect: 'text' }}>{ea?.token ?? '…'}</b>
                      <Button size="sm" disabled={!ea} onClick={() => { void navigator.clipboard.writeText(ea!.token).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy token'}</Button>
                    </div>
                    <div>{ea?.connected ? 'EA connected.' : 'EA not connected yet.'}</div>
                  </div>
                )}
                <span className="hint">Save to switch. The EA only streams data until you set EnableTrading=true in its inputs; Aurum's risk rules and Confirm dialogs apply either way. Pending orders are not supported over the EA yet.</span>
              </div>
              <div className="field">
                <label htmlFor="mt5path">MT5 terminal path (optional)</label>
                <input id="mt5path" className="input mono" placeholder="Auto-detect (e.g. C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe)" value={mt5Path} onChange={(e) => setMt5Path(e.target.value)} />
                <span className="hint">Leave empty to attach to the open terminal. Set it if you have several MT5 installs or see "Authorization failed". Open MT5 and log in first.</span>
              </div>
              <div className="field">
                <label htmlFor="pip">Pip size (price units)</label>
                <input id="pip" className="input mono" style={{ maxWidth: 140 }} value={pip} onChange={(e) => setPip(e.target.value)} />
                <span className="hint">Gold is usually 0.10, so 50–100 pips is 5–10 in price. Confirm against your broker.</span>
              </div>
            <NotificationSettings config={config} onSave={onSave} />
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
          {tab === 'trading' && <TradingTab config={config} onSave={onSave} />}
          {tab === 'connectors' && <ConnectorsSettings api={api} config={config} onSave={onSave} />}
          {tab === 'whatsapp' && <WhatsAppSettings api={api} />}
        </div></div>
        <div className="dialog-f">
          <Button onClick={onClose}>{tab === 'ai' || tab === 'connectors' || tab === 'whatsapp' ? 'Close' : 'Cancel'}</Button>
          {tab !== 'ai' && tab !== 'connectors' && tab !== 'trading' && tab !== 'whatsapp' &&<Button variant="primary" disabled={!valid} onClick={async () => { await onSave({ brokerSymbol: symbol.trim(), mt5Path: mt5Path.trim(), mt5Mode: mode, pipSize: pipNum, toolStyles: styles }); onClose(); }}>Save</Button>}
        </div>
      </div>
    </div>
  );
}
