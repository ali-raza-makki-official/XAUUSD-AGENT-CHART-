import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown, Radar, Ban, Bell, BellOff, BellRing, BoxSelect, CalendarClock, CircleAlert, CircleCheck, Clock, Gauge, Globe2, Hourglass, Pencil,
  Plus, Redo2, Send, Slash, Target, Timer, Trash2, Undo2, Wifi, X, type LucideIcon,
} from 'lucide-react';
import {
  SESSION_LABEL, SESSION_NAMES, TIMEFRAMES, alertDraftsForDrawing, describeCondition, makeAlert,
  type Alert, type AlertCommand, type AlertsSnapshot, type AlertView, type AppConfig, type ConditionType, type Drawing, type FireRecord, type Repeat, type Severity,
} from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { buildCondition, emptyForm, formFromCondition, type AlertForm } from '../lib/alertForm';
import { Button, Chip, EmptyState, IconButton, Section, Segmented, Switch, type Tone } from './ui';

const cid = () => crypto.randomUUID();
const TYPE_ICON: Record<ConditionType, LucideIcon> = {
  price_cross: ArrowUpDown, near: Radar, zone: BoxSelect, trendline: Slash, candle_close: Timer, spread: Gauge, feed: Wifi,
  position_plan: Target, session: Globe2, schedule: CalendarClock,
};
const TYPE_LABEL: Record<ConditionType, string> = {
  price_cross: 'Price cross', near: 'Approaching a level', zone: 'Zone', trendline: 'Trendline', candle_close: 'Candle close', spread: 'Spread', feed: 'Feed status',
  position_plan: 'Position plan', session: 'Session', schedule: 'Schedule',
};
const STATUS: Record<AlertView['status'], { tone: Tone; icon: LucideIcon; text: string }> = {
  armed: { tone: 'ok', icon: BellRing, text: 'Armed' },
  pending: { tone: 'neutral', icon: Hourglass, text: 'Waiting for data' },
  waiting: { tone: 'warn', icon: Hourglass, text: 'Waiting' },
  disabled: { tone: 'neutral', icon: BellOff, text: 'Disabled' },
  done: { tone: 'gold', icon: CircleCheck, text: 'Fired' },
  expired: { tone: 'neutral', icon: Clock, text: 'Expired' },
  invalid: { tone: 'danger', icon: CircleAlert, text: 'Invalid' },
  missed: { tone: 'warn', icon: CircleAlert, text: 'Missed' },
  ok: { tone: 'ok', icon: BellRing, text: 'Armed' },
};
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Live alert snapshot from the main process (alerts run there, so this only displays and sends commands). */
export function useAlerts(api: AurumApi | undefined) {
  const [snap, setSnap] = useState<AlertsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.alertsSnapshot().then(setSnap).catch((e) => setError(errText(e)));
    return api.onAlertsChanged(setSnap);
  }, [api]);
  const dispatch = useCallback(async (label: string, ops: AlertCommand['ops']) => {
    if (!api) return { ok: false as const, error: 'Not running inside the Aurum app.' };
    try {
      const r = await api.alertsDispatch({ commandId: cid(), actor: 'manual', label, ops });
      if (!r.ok) setError(r.error); else setError(null);
      return r;
    } catch (e) { const m = errText(e); setError(m); return { ok: false as const, error: m }; }
  }, [api]);
  return { snap, error, setError, dispatch };
}

// ---------- toast when an alert fires ----------

interface Toast { id: string; title: string; body: string; severity: Severity }
export function AlertToasts({ api }: { api: AurumApi | undefined }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => api?.onAlertFired((f: FireRecord) => {
    const t: Toast = { id: f.id, title: f.alertName, body: f.message, severity: f.severity };
    setToasts((cur) => [...cur, t].slice(-3));
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), 10_000);
  }), [api]);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="region" aria-label="Alert notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.severity}`} role="status" data-testid="alert-toast">
          <BellRing size={16} aria-hidden="true" />
          <div className="toast-b"><b>{t.title}</b><span>{t.body}</span></div>
          <IconButton label="Dismiss" onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}><X size={14} /></IconButton>
        </div>
      ))}
    </div>
  );
}

// ---------- create / edit dialog ----------

const sel = <T extends string>(value: T, onChange: (v: T) => void, options: { value: T; label: string }[], label: string) => (
  <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
);
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="field"><label>{label}</label>{children}</div>;

function AlertDialog({ api, config, edit, onClose, dispatch }: {
  api: AurumApi; config: AppConfig | null; edit: Alert | null; onClose: () => void; dispatch: ReturnType<typeof useAlerts>['dispatch'];
}) {
  const [form, setForm] = useState<AlertForm>(() => (edit ? formFromCondition(edit.condition) : emptyForm()));
  const [name, setName] = useState(edit?.name ?? '');
  const [repeat, setRepeat] = useState<Repeat>(edit?.repeat ?? { mode: 'once' });
  const [severity, setSeverity] = useState<Severity>(edit?.severity ?? 'info');
  const [channels, setChannels] = useState(edit?.channels ?? { desktop: true, whatsapp: false, sound: false });
  const [message, setMessage] = useState(edit?.message ?? '');
  const [expires, setExpires] = useState(edit?.expiresAt ? new Date(edit.expiresAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AlertForm>(k: K, v: AlertForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    void api.loadDrawings(config?.symbol ?? 'XAUUSD').then((r) => setDrawings(r.drawings)).catch(() => undefined);
    if (!edit) void api.snapshot().then((s) => { if (s.tick) setForm((f) => (f.level === '' ? { ...f, level: s.tick!.bid.toFixed(2) } : f)); }).catch(() => undefined);
  }, [api, config?.symbol, edit]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const drawingsOf = (kinds: string[]) => drawings.filter((d) => kinds.includes(d.kind));
  const needsDrawing = (form.type === 'zone' && form.zoneMode === 'drawing') || form.type === 'trendline' || form.type === 'near' || form.type === 'position_plan';
  const pick = form.type === 'zone' ? drawingsOf(['zone']) : form.type === 'near' ? drawingsOf(['zone', 'hline', 'trendline', 'ray']) : form.type === 'trendline' ? drawingsOf(['trendline', 'ray', 'hline']) : drawingsOf(['position']);
  useEffect(() => {
    if (needsDrawing && !pick.some((d) => d.id === form.drawingId)) setForm((f) => ({ ...f, drawingId: pick[0]?.id ?? '' }));
  }, [needsDrawing, pick.map((d) => d.id).join(','), form.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeOptions = (Object.keys(TYPE_LABEL) as ConditionType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }));
  const price = (id: string, label: string, key: 'level' | 'low' | 'high' | 'threshold' | 'tolerance') => (
    <Row label={label}><input id={id} className="input mono" type="number" step="0.01" value={form[key]} onChange={(e) => set(key, e.target.value)} /></Row>
  );
  const dirSeg = <Segmented<'above' | 'below'> label="Direction" size="sm" value={form.direction} onChange={(v) => set('direction', v)} options={[{ value: 'above', label: 'Crosses above' }, { value: 'below', label: 'Crosses below' }]} />;
  const sourceSel = <Row label="Price used">{sel(form.source, (v) => set('source', v), [{ value: 'bid', label: 'Bid' }, { value: 'ask', label: 'Ask' }, { value: 'mid', label: 'Mid' }], 'Price source')}</Row>;
  const drawingSel = (
    <Row label="Drawing">
      {pick.length ? sel(form.drawingId, (v) => set('drawingId', v), pick.map((d) => ({ value: d.id, label: `${d.label || d.kind} (${d.kind})` })), 'Drawing')
        : <span className="hint">No matching drawing on this chart. Draw one first.</span>}
    </Row>
  );

  const submit = async () => {
    setErr(null);
    const built = buildCondition(form);
    if (!built.ok) { setErr(built.error); return; }
    let expiresAt: number | null = null;
    if (expires) { expiresAt = new Date(expires).getTime(); if (!Number.isFinite(expiresAt)) { setErr('Invalid expiry time.'); return; } }
    setBusy(true);
    try {
      if (edit) {
        const patch: Record<string, unknown> = { name: name.trim() || edit.name, severity, channels, message };
        if (JSON.stringify(built.condition) !== JSON.stringify(edit.condition)) patch.condition = built.condition;
        if (JSON.stringify(repeat) !== JSON.stringify(edit.repeat)) patch.repeat = repeat;
        if (expiresAt !== edit.expiresAt) patch.expiresAt = expiresAt;
        const r = await dispatch(`Edit alert "${edit.name}"`, [{ op: 'update', id: edit.id, patch }]);
        if (!r.ok) setErr(r.error); else onClose();
      } else {
        const a = makeAlert(built.condition, { actor: 'manual', name: name.trim() || undefined, repeat, severity, channels, message, expiresAt });
        const r = await dispatch(`Create alert "${a.name}"`, [{ op: 'create', alert: a }]);
        if (!r.ok) setErr(r.error); else onClose();
      }
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="dialog-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={edit ? 'Edit alert' : 'New alert'}>
        <div className="dialog-h"><h3>{edit ? 'Edit alert' : 'New alert'}</h3><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton></div>
        <div className="dialog-b">
          <Row label="Type"><select className="select" aria-label="Alert type" value={form.type} onChange={(e) => {
            const t = e.target.value as ConditionType;
            set('type', t);
            if (!edit) setRepeat(t === 'session' || t === 'schedule' ? { mode: 'every', cooldownSec: 0 } : { mode: 'once' });
          }}>{typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Row>

          {form.type === 'price_cross' && (<>{dirSeg}{price('al-level', 'Price level', 'level')}{sourceSel}</>)}
          {form.type === 'zone' && (<>
            <Row label="When price">{sel(form.zoneEvent, (v) => set('zoneEvent', v), [{ value: 'touch', label: 'Touches the zone' }, { value: 'enter', label: 'Enters the zone' }, { value: 'exit', label: 'Exits the zone' }], 'Zone event')}</Row>
            <Segmented<'drawing' | 'range'> label="Zone source" size="sm" value={form.zoneMode} onChange={(v) => set('zoneMode', v)} options={[{ value: 'drawing', label: 'A zone drawing' }, { value: 'range', label: 'Price range' }]} />
            {form.zoneMode === 'drawing' ? drawingSel : (<>{price('al-low', 'Low', 'low')}{price('al-high', 'High', 'high')}</>)}
            {sourceSel}
          </>)}
          {form.type === 'near' && (<>{drawingSel}{price('al-near', 'Warn when price is this far away (price units)', 'tolerance')}{sourceSel}</>)}
          {form.type === 'trendline' && (<>{drawingSel}{price('al-tol', 'Tolerance (price units)', 'tolerance')}{sourceSel}</>)}
          {form.type === 'candle_close' && (<>
            <Row label="Timeframe">{sel(form.tf, (v) => set('tf', v), TIMEFRAMES.map((t) => ({ value: t, label: t })), 'Timeframe')}</Row>
            <Segmented<'above' | 'below'> label="Direction" size="sm" value={form.direction} onChange={(v) => set('direction', v)} options={[{ value: 'above', label: 'Closes above' }, { value: 'below', label: 'Closes below' }]} />
            {price('al-level', 'Price level', 'level')}
          </>)}
          {form.type === 'spread' && price('al-thr', 'Spread above (price units)', 'threshold')}
          {form.type === 'feed' && <Row label="Feed becomes">{sel(form.feedState, (v) => set('feedState', v), [{ value: 'either', label: 'Stale or disconnected' }, { value: 'stale', label: 'Stale' }, { value: 'disconnected', label: 'Disconnected' }], 'Feed state')}</Row>}
          {form.type === 'position_plan' && (<>
            {drawingSel}
            <Row label="When price reaches">{sel(form.planEvent, (v) => set('planEvent', v), [{ value: 'entry', label: 'Entry' }, { value: 'sl', label: 'Stop loss' }, { value: 'tp', label: 'Take profit' }], 'Plan event')}</Row>
            {form.planEvent === 'tp' && <Row label="Take profit number"><input className="input mono" type="number" min={1} max={5} value={form.tpIndex} aria-label="Take profit number" onChange={(e) => set('tpIndex', e.target.value)} /></Row>}
          </>)}
          {form.type === 'session' && (<>
            <Row label="Session">{sel(form.session, (v) => set('session', v), SESSION_NAMES.map((s) => ({ value: s, label: SESSION_LABEL[s] })), 'Session')}</Row>
            <Row label="Event">{sel(form.sessionEvent, (v) => set('sessionEvent', v), [{ value: 'open', label: 'Opens' }, { value: 'close', label: 'Closes' }], 'Session event')}</Row>
          </>)}
          {form.type === 'schedule' && (<>
            <Segmented<'once' | 'daily'> label="Schedule kind" size="sm" value={form.when} onChange={(v) => { set('when', v); if (!edit) setRepeat(v === 'once' ? { mode: 'once' } : { mode: 'every', cooldownSec: 0 }); }} options={[{ value: 'once', label: 'One time' }, { value: 'daily', label: 'Every day' }]} />
            {form.when === 'once'
              ? <Row label="Date and time (your local time)"><input className="input mono" type="datetime-local" aria-label="Date and time" value={form.at} onChange={(e) => set('at', e.target.value)} /></Row>
              : (<>
                <Row label="Time (24 hour)"><input className="input mono" type="time" aria-label="Time" value={form.time} onChange={(e) => set('time', e.target.value)} /></Row>
                <Row label="Time zone (IANA)"><input className="input mono" aria-label="Time zone" value={form.tz} onChange={(e) => set('tz', e.target.value)} /></Row>
                <div className="perm"><b>Weekdays only</b><Switch label="Weekdays only" checked={form.weekdaysOnly} onChange={(v) => set('weekdaysOnly', v)} /></div>
              </>)}
          </>)}

          <Row label="Name (optional)"><input className="input" maxLength={80} aria-label="Alert name" placeholder="Generated from the condition" value={name} onChange={(e) => setName(e.target.value)} /></Row>
          <Row label="How often">
            <div className="row">
              {sel(repeat.mode, (m) => setRepeat(m === 'once' ? { mode: 'once' } : m === 'every' ? { mode: 'every', cooldownSec: 60 } : { mode: 'per_bar', timeframe: 'M15' }), [{ value: 'once', label: 'Once, then stop' }, { value: 'every', label: 'Every time (with cooldown)' }, { value: 'per_bar', label: 'At most once per bar' }], 'Repeat')}
              {repeat.mode === 'every' && <><input className="input mono" style={{ width: 90 }} type="number" min={0} aria-label="Cooldown seconds" value={repeat.cooldownSec} onChange={(e) => setRepeat({ mode: 'every', cooldownSec: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /><span className="hint">seconds apart</span></>}
              {repeat.mode === 'per_bar' && sel(repeat.timeframe, (v) => setRepeat({ mode: 'per_bar', timeframe: v }), TIMEFRAMES.map((t) => ({ value: t, label: t })), 'Bar timeframe')}
            </div>
          </Row>
          <Row label="Importance">
            <Segmented<Severity> label="Severity" size="sm" value={severity} onChange={setSeverity} options={[{ value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical' }]} />
          </Row>
          <Row label="Notify by">
            <div className="perm"><b>Desktop notification</b><Switch label="Desktop notification" checked={channels.desktop} onChange={(v) => setChannels({ ...channels, desktop: v })} /></div>
            <div className="perm"><b>Sound</b><Switch label="Sound" checked={channels.sound} onChange={(v) => setChannels({ ...channels, sound: v })} /></div>
            <div className="perm"><div><b>WhatsApp</b><span className="hint">Sent only if the WhatsApp connector is set up</span></div><Switch label="WhatsApp" checked={channels.whatsapp} onChange={(v) => setChannels({ ...channels, whatsapp: v })} /></div>
          </Row>
          <Row label="Message (optional; {name} {price} {level} {reason} {time} {symbol})"><input className="input" maxLength={500} aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} /></Row>
          <Row label="Expires (optional)"><input className="input mono" type="datetime-local" aria-label="Expiry" value={expires} onChange={(e) => setExpires(e.target.value)} /></Row>
          <p className="hint" style={{ margin: 0 }}>{(() => { const b = buildCondition(form); return b.ok ? `Alert: ${describeCondition(b.condition)}. Alerts only run while Aurum is open (it can be minimised).` : ''; })()}</p>
          {err && <div className="banner banner-warn" role="alert"><CircleAlert size={14} /><span>{err}</span></div>}
        </div>
        <div className="dialog-f"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>{edit ? 'Save changes' : 'Create alert'}</Button></div>
      </div>
    </div>
  );
}

// ---------- the panel ----------

type View = 'alerts' | 'fires' | 'log';

export function AlertsPanel({ api, config }: { api?: AurumApi; config?: AppConfig | null }) {
  const { snap, error, setError, dispatch } = useAlerts(api);
  const [view, setView] = useState<View>('alerts');
  const [dialog, setDialog] = useState<null | 'new' | Alert>(null);
  const [note, setNote] = useState<string | null>(null);
  const alerts = snap?.alerts ?? [];
  const byId = useMemo(() => new Map(alerts.map((v) => [v.alert.id, v])), [alerts]);

  if (!api) return <EmptyState icon={Bell} title="Alerts need the Aurum app">Open Aurum on your PC to create alerts.</EmptyState>;
  const act = async (p: Promise<unknown>) => { try { await p; } catch (e) { setError(errText(e)); } };
  const test = async (id: string) => { try { const r = await api.alertsTestFire(id); setNote(r.ok ? 'Test notification sent through the real channels.' : r.error ?? 'Test failed.'); } catch (e) { setError(errText(e)); } };

  return (
    <div className="alerts" data-testid="alerts-panel">
      <div className="row" style={{ marginBottom: 6 }}>
        <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog('new')}>New alert</Button>
        <IconButton label="Undo alert change" disabled={!snap?.canUndo} onClick={() => void act(api.alertsUndo())}><Undo2 size={15} /></IconButton>
        <IconButton label="Redo alert change" disabled={!snap?.canRedo} onClick={() => void act(api.alertsRedo())}><Redo2 size={15} /></IconButton>
        <Segmented<View> label="Alerts view" size="sm" value={view} onChange={setView} options={[{ value: 'alerts', label: `Alerts (${alerts.length})` }, { value: 'fires', label: 'Fire history' }, { value: 'log', label: 'Notification log' }]} />
        <span className="hint">Alerts run while Aurum is open, even minimised.</span>
      </div>
      {error && <div className="banner banner-warn" role="alert" style={{ marginBottom: 6 }}><CircleAlert size={14} /><span>{error}</span><Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button></div>}
      {note && <div className="banner banner-ok" role="status" style={{ marginBottom: 6 }}><CircleCheck size={14} /><span>{note}</span><Button size="sm" variant="ghost" onClick={() => setNote(null)}>Dismiss</Button></div>}

      {view === 'alerts' && (alerts.length === 0
        ? <EmptyState icon={Bell} title="No alerts yet">Create one here, from a drawing in the Inspector, or ask the AI (if you allow it in Settings).</EmptyState>
        : <div className="alist" role="list">{alerts.map((v) => {
          const st = STATUS[v.status]; const Icon = TYPE_ICON[v.alert.condition.type];
          return (
            <div className="arow" role="listitem" key={v.alert.id} data-testid="alert-row" data-status={v.status}>
              <span className="kind" title={TYPE_LABEL[v.alert.condition.type]}><Icon size={15} aria-hidden="true" /></span>
              <div className="ainfo">
                <b>{v.alert.name}</b>
                <span className="hint">{v.summary} · {v.repeatLabel}{v.alert.origin.by === 'ai' ? ' · created by AI' : ''}</span>
                <span className="hint">{v.status === 'done' || v.status === 'armed' || v.status === 'disabled' ? '' : v.statusDetail}{v.nextAt ? ` Next: ${when(Date.parse(v.nextAt))}` : ''}</span>
              </div>
              <Chip tone={st.tone} icon={st.icon}>{st.text}</Chip>
              <span className="hint alast" data-testid="alert-last">{v.lastFiredAt ? `Fired ${when(v.lastFiredAt)}${v.fireCount > 1 ? ` (x${v.fireCount})` : ''}` : 'Never fired'}</span>
              <Switch label={`Enable ${v.alert.name}`} checked={v.alert.enabled} onChange={(en) => void dispatch(`${en ? 'Enable' : 'Disable'} alert "${v.alert.name}"`, [{ op: 'update', id: v.alert.id, patch: { enabled: en } }])} />
              {v.status === 'done' && <IconButton label={`Re-arm ${v.alert.name}`} onClick={() => void dispatch(`Re-arm alert "${v.alert.name}"`, [{ op: 'update', id: v.alert.id, patch: { rearm: true } }])}><BellRing size={15} /></IconButton>}
              <IconButton label={`Send test notification for ${v.alert.name}`} onClick={() => void test(v.alert.id)}><Send size={15} /></IconButton>
              <IconButton label={`Edit ${v.alert.name}`} onClick={() => setDialog(v.alert)}><Pencil size={15} /></IconButton>
              <IconButton label={`Delete ${v.alert.name}`} tone="danger" onClick={() => void dispatch(`Delete alert "${v.alert.name}"`, [{ op: 'delete', id: v.alert.id }])}><Trash2 size={15} /></IconButton>
            </div>
          );
        })}</div>)}

      {view === 'fires' && ((snap?.fires.length ?? 0) === 0
        ? <EmptyState icon={Clock} title="Nothing has fired yet" />
        : <div className="log" data-testid="fire-history">{snap!.fires.map((f) => (
          <div key={f.id}><span className="t">{when(f.at)}</span><span className="lvl" style={{ color: f.kind === 'missed' ? 'var(--warn)' : 'var(--gold)' }}>{f.kind === 'missed' ? 'MISSED' : 'FIRED'}</span>{f.alertName}: {f.reason}</div>
        ))}</div>)}

      {view === 'log' && ((snap?.notifications.length ?? 0) === 0
        ? <EmptyState icon={Ban} title="No notifications yet" />
        : <div className="log" data-testid="notification-log">{snap!.notifications.map((n) => (
          <div key={n.event.id} data-testid="notification-entry"><span className="t">{when(n.event.at)}</span><span className="lvl">{n.event.title}</span>{n.event.body}
            {' '}{n.deliveries.length === 0 ? <span className="hint">(in-app only)</span> : n.deliveries.map((d, i) => <span key={i} className="hint">[{d.channel}: {d.status}{d.detail ? `, ${d.detail}` : ''}] </span>)}
            {byId.has(n.event.alertId) ? '' : <span className="hint">(alert deleted)</span>}
          </div>
        ))}</div>)}

      {dialog && <AlertDialog api={api} config={config ?? null} edit={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} dispatch={dispatch} />}
    </div>
  );
}

// ---------- "Alert when price touches this" in the drawing Inspector ----------

export function DrawingAlertAction({ api, d, price }: { api?: AurumApi; d: Drawing; price: number | null }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const drafts = useMemo(() => alertDraftsForDrawing(d, price), [d, price]);
  if (!api || drafts.length === 0) return null;
  const create = async (i: number) => {
    const draft = drafts[i]!;
    try {
      const a = makeAlert(draft.condition, { actor: 'manual' });
      const r = await api.alertsDispatch({ commandId: cid(), actor: 'manual', label: `Create alert "${a.name}"`, ops: [{ op: 'create', alert: a }] });
      setMsg(r.ok ? { ok: true, text: `Alert created: ${a.name}. See the Alerts tab.` } : { ok: false, text: r.error });
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  };
  return (
    <Section title="Alerts">
      <div className="row">{drafts.map((x, i) => <Button key={x.label} size="sm" icon={Bell} onClick={() => void create(i)}>{drafts.length === 1 ? 'Alert when price touches this' : x.label}</Button>)}</div>
      {drafts.length === 1 && <span className="hint">{drafts[0]!.label}</span>}
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-warn'}`} role="status">{msg.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}<span>{msg.text}</span></div>}
    </Section>
  );
}

// ---------- notification settings (mounted by the Settings dialog) ----------

export function NotificationSettings({ config, onSave }: { api?: AurumApi; config: AppConfig; onSave: (patch: Partial<AppConfig>) => Promise<void> }) {
  const [n, setN] = useState(config.notifications);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const q = n.quietHours;
  const save = async () => {
    try { await onSave({ notifications: n }); setMsg({ ok: true, text: 'Notification settings saved.' }); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  };
  return (
    <Section title="Notifications">
      <div className="perm"><div><b>Desktop notifications</b><span className="hint">Master switch for pop-ups from alerts</span></div><Switch label="Desktop notifications" checked={n.desktopEnabled} onChange={(v) => setN({ ...n, desktopEnabled: v })} /></div>
      <div className="perm"><div><b>Sound</b><span className="hint">Only alerts that have sound turned on will play it</span></div><Switch label="Notification sound" checked={n.sound} onChange={(v) => setN({ ...n, sound: v })} /></div>
      {(['info', 'warning', 'critical'] as const).map((s) => (
        <div className="perm" key={s}><div><b>Show {s} alerts</b></div><Switch label={`Show ${s} alerts`} checked={n.severities[s]} onChange={(v) => setN({ ...n, severities: { ...n.severities, [s]: v } })} /></div>
      ))}
      <div className="perm"><div><b>Quiet hours</b><span className="hint">Alerts are still logged, but no pop-up or sound</span></div><Switch label="Quiet hours" checked={q.enabled} onChange={(v) => setN({ ...n, quietHours: { ...q, enabled: v } })} /></div>
      {q.enabled && (
        <div className="row">
          <input className="input mono" style={{ width: 110 }} type="time" aria-label="Quiet hours start" value={q.start} onChange={(e) => setN({ ...n, quietHours: { ...q, start: e.target.value } })} />
          <span className="hint">to</span>
          <input className="input mono" style={{ width: 110 }} type="time" aria-label="Quiet hours end" value={q.end} onChange={(e) => setN({ ...n, quietHours: { ...q, end: e.target.value } })} />
          <input className="input mono" style={{ width: 180 }} aria-label="Quiet hours time zone" value={q.tz} onChange={(e) => setN({ ...n, quietHours: { ...q, tz: e.target.value } })} />
        </div>
      )}
      {q.enabled && <div className="perm"><div><b>Critical alerts ignore quiet hours</b></div><Switch label="Critical alerts ignore quiet hours" checked={q.allowCritical} onChange={(v) => setN({ ...n, quietHours: { ...q, allowCritical: v } })} /></div>}
      <div><Button variant="primary" onClick={() => void save()}>Save notification settings</Button></div>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-warn'}`} role="status"><span>{msg.text}</span></div>}
    </Section>
  );
}
