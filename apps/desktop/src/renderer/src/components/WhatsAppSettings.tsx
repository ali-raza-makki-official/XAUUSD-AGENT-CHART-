import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, CircleX, History, KeyRound, Link2, LoaderCircle, MessageCircle, Plug, RefreshCw, ShieldAlert, Unlink, Zap } from 'lucide-react';
import { WA_LEVEL_LABEL, type WaPermissionLevel } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import type { WaUiSettings, WaUiSettingsPatch, WaUiStatus } from '../../../whatsappShared';
import { Button, Chip, Section, Segmented, Switch, type Tone } from './ui';
import { WhatsAppHistory } from './WhatsAppHistory';

const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
const LEVELS: WaPermissionLevel[] = ['notify', 'ask', 'chart', 'trade'];
const LEVEL_SHORT: Record<WaPermissionLevel, string> = { notify: 'Notify only', ask: 'Ask AI', chart: 'Chart control', trade: 'Trade actions' };

function connection(s: WaUiStatus): { tone: Tone; icon: typeof CircleCheck; text: string } {
  if (!s.hasToken) return { tone: 'warn', icon: KeyRound, text: 'No token saved' };
  switch (s.state) {
    case 'polling': return { tone: 'ok', icon: CircleCheck, text: 'Connected' };
    case 'connecting': return { tone: 'neutral', icon: LoaderCircle, text: 'Connecting' };
    case 'backoff': return { tone: 'warn', icon: RefreshCw, text: 'Retrying' };
    case 'conflict': return { tone: 'danger', icon: ShieldAlert, text: 'Another client took over' };
    case 'auth_error': return { tone: 'danger', icon: CircleX, text: 'Token rejected' };
    default: return { tone: 'neutral', icon: Plug, text: 'Stopped' };
  }
}

export function WhatsAppSettings({ api }: { api: AurumApi }) {
  const [st, setSt] = useState<WaUiStatus | null>(null);
  const [cfg, setCfg] = useState<WaUiSettings | null>(null);
  const [token, setToken] = useState('');
  const [briefMsg, setBriefMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(() => { api.waStatus().then(setSt).catch(() => undefined); }, [api]);
  useEffect(() => {
    refresh();
    void api.waGetSettings().then(setCfg);
    const off = api.onWaStatus(setSt);
    const t = setInterval(refresh, 3000); // the countdown / last-sync text stays fresh
    return () => { off(); clearInterval(t); };
  }, [api, refresh]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: clean(e) }); } finally { setBusy(null); refresh(); }
  };
  const patch = (p: WaUiSettingsPatch) => run('settings', async () => { setCfg(await api.waSetSettings(p)); });

  if (!st || !cfg) return <span className="hint">Loading WhatsApp settings…</span>;
  const conn = connection(st);
  const linked = st.link.status === 'linked';
  const pairing = st.link.status === 'pairing';
  const mins = (ms: number) => Math.max(0, Math.ceil((ms - Date.now()) / 60000));

  return (
    <>
      <Section title="Status">
        <div className="row" data-testid="wa-status-chips">
          <Chip tone={conn.tone} icon={conn.icon}>{conn.text}</Chip>
          <Chip tone={linked ? 'ok' : pairing ? 'gold' : 'neutral'} icon={linked ? Link2 : pairing ? LoaderCircle : Unlink}>{linked ? 'Chat linked' : pairing ? 'Pairing' : 'Not linked'}</Chip>
          {st.remotePaused && <Chip tone="warn" icon={CircleAlert}>Remote actions paused</Chip>}
          <Chip tone={st.aiWindowReady ? 'ok' : 'warn'} icon={st.aiWindowReady ? CircleCheck : CircleAlert}>{st.aiWindowReady ? 'AI ready' : 'AI window not ready'}</Chip>
          <Chip tone={st.alertsChannelRegistered ? 'ok' : 'neutral'} icon={st.alertsChannelRegistered ? CircleCheck : CircleAlert}>{st.alertsChannelRegistered ? 'Alerts to WhatsApp on' : 'Alerts channel not connected'}</Chip>
        </div>
        <div className="hint">
          Last sync: {st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleTimeString() : 'never'} · Sent this minute: {st.rate.sendUsed}/{st.rate.sendLimit}{st.rate.queued ? ` (${st.rate.queued} queued)` : ''}
          {st.nextRetryAt ? ` · next retry ${new Date(st.nextRetryAt).toLocaleTimeString()}` : ''}
        </div>
        {st.lastError && <div className="banner banner-warn" role="status"><CircleAlert size={14} /><span>Last error ({st.lastError.kind}) at {new Date(st.lastError.at).toLocaleTimeString()}: {st.lastError.message}</span></div>}
        {!st.secureStorage && <Chip tone="danger" icon={CircleX}>Secure storage is unavailable on this system, so the token cannot be saved.</Chip>}
        <div className="hint">Aurum answers only while this app is running on your PC. If the PC or the app is off, messages wait on WhatsApp and Aurum will not act on old ones (it sends one summary).</div>
      </Section>

      <Section title="1. API token">
        <div className="field">
          <label htmlFor="wa-token">Agent API token {st.hasToken ? <Chip tone="ok" icon={CircleCheck}>Saved</Chip> : <Chip tone="warn" icon={KeyRound}>Not set</Chip>}</label>
          <div className="row">
            <input id="wa-token" type="password" className="input mono" style={{ flex: 1 }} autoComplete="off" spellCheck={false} placeholder={st.hasToken ? '•••••••••• (saved, enter a new one to replace)' : 'Paste the token of your WhatsApp agent'} value={token} onChange={(e) => setToken(e.target.value)} />
            <Button variant="primary" icon={KeyRound} disabled={token.trim().length < 8 || busy !== null || !st.secureStorage} onClick={() => run('token', async () => { await api.waSetToken(token.trim()); setToken(''); setMsg({ ok: true, text: 'Token saved (encrypted on this PC).' }); })}>Save token</Button>
            {st.hasToken && <Button variant="danger" disabled={busy !== null} onClick={() => run('clear', async () => { await api.waClearToken(); setMsg({ ok: true, text: 'Token removed, polling stopped and the chat was unlinked.' }); })}>Remove</Button>}
          </div>
          <span className="hint">Stored encrypted by the operating system and used only by the background process. It is never shown again, never sent to the chart UI or the AI, and never written to logs.</span>
        </div>
      </Section>

      <Section title="2. Link your WhatsApp chat">
        <ol className="hint" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }} data-testid="wa-steps">
          <li>Save the token above.</li>
          <li>Press <b>Start pairing</b>. Aurum starts listening for your messages.</li>
          <li>On your phone, open your agent chat in WhatsApp and send any message, for example &quot;hi&quot;. Only your own chat with your agent works.</li>
          <li>Aurum replies in WhatsApp and a 6-digit code appears here. Type that code as your reply in WhatsApp. It expires in 5 minutes.</li>
          <li>When the status says <b>Chat linked</b>, send <code>/help</code>.</li>
        </ol>
        {pairing && st.link.status === 'pairing' && (
          <div className="banner banner-ok" role="status" data-testid="wa-pairing-code">
            <ShieldAlert size={14} /><span>Reply to the agent in WhatsApp with this code: <b className="mono" style={{ fontSize: 18, letterSpacing: 3 }}>{st.link.code}</b> (about {mins(st.link.expiresAt)} min left, {5 - st.link.attempts} tries). Do not share it.</span>
          </div>
        )}
        {linked && <div className="banner banner-ok" role="status"><CircleCheck size={14} /><span>Linked{st.link.status === 'linked' ? ` since ${new Date(st.link.linkedAt).toLocaleString()}` : ''}. Only this chat can give Aurum commands.</span></div>}
        <div className="row">
          <Button variant="primary" icon={MessageCircle} disabled={!st.hasToken || busy !== null || linked} onClick={() => run('pair', async () => { await api.waStartPairing(); setMsg({ ok: true, text: 'Listening. Now send a message to your agent in WhatsApp.' }); })}>Start pairing</Button>
          {pairing && <Button disabled={busy !== null} onClick={() => run('cancelpair', () => api.waCancelPairing())}>Cancel pairing</Button>}
          <Button icon={Zap} disabled={!st.hasToken || busy !== null} onClick={() => run('test', async () => { const r = await api.waTest(); setMsg({ ok: r.ok, text: r.message }); })}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
          {linked && <Button variant="danger" icon={Unlink} disabled={busy !== null} onClick={() => run('unlink', async () => { await api.waUnlink(); setMsg({ ok: true, text: 'Unlinked. Use Start pairing to link again.' }); })}>Unlink</Button>}
          {busy && <LoaderCircle size={14} className="spin" />}
        </div>
        {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-warn'}`} role="status">{msg.ok ? <CircleCheck size={14} /> : <CircleX size={14} />}<span>{msg.text}</span></div>}
      </Section>

      <Section title="What WhatsApp may do">
        <div className="perm"><div><b>Listening</b><span className="hint">Poll WhatsApp for your messages and send alerts</span></div><Switch label="WhatsApp gateway on" checked={cfg.enabled} onChange={(v) => run('run', () => api.waSetRunning(v).then(() => api.waGetSettings().then(setCfg)))} disabled={!st.hasToken} /></div>
        <Segmented<WaPermissionLevel> label="Permission level for WhatsApp" value={cfg.permission} onChange={(v) => void patch({ permission: v })} options={LEVELS.map((l) => ({ value: l, label: LEVEL_SHORT[l], title: WA_LEVEL_LABEL[l] }))} />
        <span className="hint" data-testid="wa-level-desc">{WA_LEVEL_LABEL[cfg.permission]}</span>
        {cfg.permission === 'trade' && <Chip tone="warn" icon={ShieldAlert}>Orders are not connected in this build; trade actions can only be proposed and will report that nothing was done.</Chip>}
        <div className="perm"><div><b>Ask for a code before chart changes</b><span className="hint">AI drawings and alert changes need CONFIRM &lt;code&gt;. Trade actions always do.</span></div><Switch label="Confirm chart actions" checked={cfg.confirmChartActions} onChange={(v) => void patch({ confirmChartActions: v })} /></div>
        <div className="perm"><div><b>Send alerts to WhatsApp</b><span className="hint">Needs the alerts module to be connected</span></div><Switch label="Send alerts to WhatsApp" checked={cfg.notifications} onChange={(v) => void patch({ notifications: v })} /></div>
        <div className="perm"><div><b>Tell me when Aurum starts, closes or loses MT5</b><span className="hint">Sent only while Aurum is running; a crash or power cut cannot send anything</span></div><Switch label="Status messages" checked={cfg.statusNotices} onChange={(v) => void patch({ statusNotices: v })} /></div>
        <div className="perm"><div><b>Morning briefing</b><span className="hint">One message a day: market and sessions, high-impact news, your open positions, yesterday's result, your view and the AI's. Only sent while Aurum is running at that time.</span></div><Switch label="Morning briefing" checked={cfg.briefing.enabled} onChange={(v) => void patch({ briefing: { enabled: v } })} /></div>
        {cfg.briefing.enabled && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input className="input mono" type="time" aria-label="Briefing time" value={cfg.briefing.time} onChange={(e) => e.target.value && void patch({ briefing: { time: e.target.value } })} />
            <input className="input mono" style={{ width: 190 }} aria-label="Briefing time zone" placeholder="Time zone, e.g. Asia/Karachi" defaultValue={cfg.briefing.tz} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== cfg.briefing.tz) void patch({ briefing: { tz: v } }); }} />
            <Button size="sm" onClick={() => void api.waBriefingTest().then((r) => setBriefMsg(r.message)).catch((e) => setBriefMsg(String(e)))}>Send it now to check</Button>
            {briefMsg && <span className="hint" role="status">{briefMsg}</span>}
            <label className="ptcheck"><input type="checkbox" checked={cfg.briefing.weekdaysOnly} onChange={(e) => void patch({ briefing: { weekdaysOnly: e.target.checked } })} />Weekdays only</label>
          </div>
        )}
        <div className="perm"><div><b>Quiet hours for outgoing alerts</b><span className="hint">Replies to your own commands are never held back</span></div><Switch label="Quiet hours" checked={cfg.quietHours.enabled} onChange={(v) => void patch({ quietHours: { enabled: v } })} /></div>
        {cfg.quietHours.enabled && (
          <div className="row">
            <label className="hint" htmlFor="wa-q1">From</label><input id="wa-q1" className="input mono" style={{ width: 80 }} defaultValue={cfg.quietHours.start} onBlur={(e) => /^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value) && void patch({ quietHours: { start: e.target.value } })} />
            <label className="hint" htmlFor="wa-q2">to</label><input id="wa-q2" className="input mono" style={{ width: 80 }} defaultValue={cfg.quietHours.end} onBlur={(e) => /^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value) && void patch({ quietHours: { end: e.target.value } })} />
            <label className="hint" htmlFor="wa-q3">time zone</label><input id="wa-q3" className="input mono" style={{ width: 160 }} defaultValue={cfg.quietHours.tz} onBlur={(e) => e.target.value.trim() && void patch({ quietHours: { tz: e.target.value.trim() } })} />
            <Switch label="Critical alerts still come through" checked={cfg.quietHours.allowCritical} onChange={(v) => void patch({ quietHours: { allowCritical: v } })} /><span className="hint">critical still sent</span>
          </div>
        )}
      </Section>

      <Section title="History" action={<Button size="sm" icon={History} onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide' : 'Show command history'}</Button>}>
        {showHistory ? <WhatsAppHistory api={api} /> : <span className="hint">Every message in and out, with what Aurum did and whether a code was needed.</span>}
      </Section>
    </>
  );
}
