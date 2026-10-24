import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, Trash2, Zap } from 'lucide-react';
import { CONNECTOR_PRESETS, GenericConnectorSchema, RELATED_ROLES, type AppConfig, type ConnectionTest, type GenericConnectorConfig } from '@aurum/core';
import type { AurumApi, ConnectorStatus } from '../../../shared';
import { Button, Chip, Switch } from './ui';

interface Props { api: AurumApi; config: AppConfig; onSave: (patch: Partial<AppConfig>) => Promise<void> }

/** Self-contained Connectors section. The lead mounts it inside Settings. Secrets go to the main process and never come back. */
export function ConnectorsSettings({ api, config, onSave }: Props) {
  const ctx = config.context;
  const [status, setStatus] = useState<ConnectorStatus[]>([]);
  const [tests, setTests] = useState<Record<string, ConnectionTest>>({});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [found, setFound] = useState<Record<string, string[]>>({});
  const [mappingText, setMappingText] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => { void api.contextStatus().then(setStatus); }, [api]);
  useEffect(reload, [reload, config.context]);
  const save = (patch: Partial<typeof ctx>) => onSave({ context: { ...ctx, ...patch } }).catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  const upd = (id: string, p: Partial<GenericConnectorConfig>) => save({ connectors: ctx.connectors.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const add = (init: Partial<GenericConnectorConfig>) => {
    const id = `${init.kind ?? 'news'}-${Date.now().toString(36)}`;
    const c = GenericConnectorSchema.parse({ id, label: 'New feed', kind: 'news', format: 'rss', url: '', ...init, enabled: false });
    void save({ connectors: [...ctx.connectors, c] });
  };
  const test = async (id: string) => { setTests((t) => ({ ...t, [id]: undefined as never })); const r = await api.contextTest(id); setTests((t) => ({ ...t, [id]: r })); reload(); };
  const st = (id: string) => status.find((s) => s.id === id);

  const Health = ({ id }: { id: string }) => {
    const s = st(id); const t = tests[id];
    if (!s) return null;
    return (
      <div className="hint">
        {s.issues.length > 0 && <div>Not ready: {s.issues.join(' ')}</div>}
        <div>Last sync: {s.health.lastSuccessfulSync ? new Date(s.health.lastSuccessfulSync).toLocaleString() : 'never'} · Rate limit: burst {s.rateLimit.capacity}, {s.rateLimit.refillPerMinute.toFixed(2)}/min{s.health.nextAllowedCall ? ` · next call after ${new Date(s.health.nextAllowedCall).toLocaleTimeString()}` : ''}</div>
        {s.health.errorStatus && <div><Chip tone="danger">Error {s.health.errorStatus.code}</Chip> {s.health.errorStatus.message}</div>}
        {t && (t.ok ? <div><Chip tone="ok">Test passed</Chip> {t.detail} ({t.latencyMs} ms)</div> : <div><Chip tone="danger">Test failed: {t.error.code}</Chip> {t.error.message}</div>)}
      </div>
    );
  };

  return (
    <div className="field" style={{ gap: 12 }}>
      <span className="lbl">Connectors (market context)</span>
      <span className="hint">Nothing is on by default. Data comes only from sources you add. No provider is bundled.</span>
      {err && <Chip tone="warn">{err}</Chip>}

      <div className="field">
        <div className="row"><strong>Market sessions</strong> <Chip>Local, no key</Chip><Switch label="Sessions" checked={ctx.sessionsEnabled} onChange={(v) => void save({ sessionsEnabled: v })} /></div>
        <span className="hint">Hours, time zones and closed windows (holidays) are editable in the config; defaults are conventions, not broker data.</span>
        <Health id="sessions" />
      </div>

      <div className="field">
        <div className="row"><strong>Related markets (MT5)</strong> <Chip>Needs MT5 symbols</Chip><Switch label="Related markets" checked={ctx.relatedEnabled} onChange={(v) => void save({ relatedEnabled: v })} />
          <Button size="sm" onClick={() => void test('related-markets').then(reload)}>Test</Button></div>
        {RELATED_ROLES.map((r) => (
          <div key={r.id} className="row">
            <label htmlFor={`rel-${r.id}`} style={{ width: 140 }}>{r.label}</label>
            <input id={`rel-${r.id}`} className="input mono" style={{ maxWidth: 160 }} value={ctx.related.symbols[r.id] ?? ''} placeholder="broker symbol"
              onChange={(e) => { const symbols = { ...ctx.related.symbols, [r.id]: e.target.value }; if (!e.target.value) delete symbols[r.id]; void save({ related: { symbols } }); }} />
            <Button size="sm" icon={Search} onClick={() => api.findSymbols(r.needles).then((l) => setFound((f) => ({ ...f, [r.id]: l }))).catch((e) => setErr(String(e)))}>Find symbols</Button>
            {found[r.id]?.map((s) => <Button key={s} size="sm" onClick={() => void save({ related: { symbols: { ...ctx.related.symbols, [r.id]: s } } })}>{s}</Button>)}
            {found[r.id]?.length === 0 && <span className="hint">None found.</span>}
          </div>
        ))}
        <Health id="related-markets" />
      </div>

      {ctx.connectors.map((c) => (
        <div key={c.id} className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div className="row">
            <input className="input" aria-label="Name" style={{ maxWidth: 200 }} value={c.label} onChange={(e) => upd(c.id, { label: e.target.value })} />
            <Chip>{c.kind} · {c.format.toUpperCase()}</Chip>
            <Switch label={`Enable ${c.label}`} checked={c.enabled} onChange={(v) => upd(c.id, { enabled: v })} />
            <Button size="sm" icon={Zap} onClick={() => void test(c.id)}>Test connection</Button>
            <Button size="sm" icon={RefreshCw} onClick={() => void api.contextRefresh().then(reload)}>Refresh</Button>
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => void save({ connectors: ctx.connectors.filter((x) => x.id !== c.id) })}>Remove</Button>
          </div>
          {c.note && <Chip tone="warn">{c.note}</Chip>}
          <div className="row">
            <select className="input" aria-label="Kind" value={c.kind} onChange={(e) => upd(c.id, { kind: e.target.value as GenericConnectorConfig['kind'] })}><option>news</option><option>calendar</option><option>sentiment</option></select>
            <select className="input" aria-label="Format" value={c.format} onChange={(e) => upd(c.id, { format: e.target.value as 'json' | 'rss' })}><option value="rss">RSS/Atom</option><option value="json">JSON</option></select>
            <label>Refresh (min)</label><input className="input mono" type="number" min={1} style={{ width: 80 }} value={c.refreshMinutes} onChange={(e) => upd(c.id, { refreshMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 30)) })} />
          </div>
          <input className="input mono" aria-label="URL" placeholder="https://… (use {{secret}} where the key goes)" defaultValue={c.url} onBlur={(e) => upd(c.id, { url: e.target.value.trim() })} />
          <div className="row">
            <input className="input mono" aria-label="Auth header name" placeholder="Auth header name (optional)" style={{ maxWidth: 200 }} defaultValue={c.authHeader ?? ''} onBlur={(e) => upd(c.id, { authHeader: e.target.value.trim() || null })} />
            <input className="input mono" type="password" aria-label="Key" placeholder={st(c.id)?.hasSecret ? 'Key saved (hidden)' : 'Key / header value'} value={secret[c.id] ?? ''} onChange={(e) => setSecret((s) => ({ ...s, [c.id]: e.target.value }))} />
            <Button size="sm" disabled={!secret[c.id]} onClick={() => void api.contextSetSecret(c.id, secret[c.id]!).then(() => { setSecret((s) => ({ ...s, [c.id]: '' })); reload(); }).catch((e) => setErr(String(e)))}>Save key</Button>
            {st(c.id)?.hasSecret && <Button size="sm" onClick={() => void api.contextClearSecret(c.id).then(reload)}>Clear key</Button>}
          </div>
          {c.format === 'json' && (
            <>
              <textarea className="textarea mono" rows={6} aria-label="Field mapping JSON" placeholder={'{"itemsPath":"$.events[*]","fields":{"time":"$.date","currency":"$.country","title":"$.title","impact":"$.impact"}}'}
                value={mappingText[c.id] ?? (c.mapping ? JSON.stringify(c.mapping, null, 1) : '')} onChange={(e) => setMappingText((m) => ({ ...m, [c.id]: e.target.value }))}
                onBlur={(e) => { try { upd(c.id, { mapping: e.target.value.trim() ? JSON.parse(e.target.value) : null }); setErr(null); } catch (x) { setErr(`Mapping: ${x instanceof Error ? x.message : x}`); } }} />
              <span className="hint">Fields: calendar time/currency/title/impact/actual/forecast/previous; news time/title/summary/url; sentiment instrument/longPct/shortPct/asOf. Paths look like $.a.b[*].c.</span>
            </>
          )}
          <Health id={c.id} />
        </div>
      ))}

      <div className="row">
        <Button size="sm" icon={Plus} onClick={() => add({ kind: 'news', format: 'rss' })}>Add RSS/Atom news feed</Button>
        <Button size="sm" icon={Plus} onClick={() => add({ kind: 'calendar', format: 'json', label: 'New calendar' })}>Add JSON calendar</Button>
        <Button size="sm" icon={Plus} onClick={() => add({ kind: 'sentiment', format: 'json', label: 'New sentiment' })}>Add JSON sentiment</Button>
        {CONNECTOR_PRESETS.map((p) => <Button key={p.presetId} size="sm" icon={Plus} onClick={() => add({ kind: p.kind, format: p.format, url: p.url, label: p.label, note: p.note })}>{p.label} (unverified)</Button>)}
      </div>
    </div>
  );
}
