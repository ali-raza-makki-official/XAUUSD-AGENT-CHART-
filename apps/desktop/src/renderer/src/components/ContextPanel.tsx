import { useEffect, useState } from 'react';
import { Clock, Newspaper, CalendarClock, Gauge, Globe2, AlertTriangle } from 'lucide-react';
import { DEFAULT_SESSIONS_SETTINGS, filterByImpact, formatDuration, sessionsSnapshot, type AppConfig, type ConnectorResult } from '@aurum/core';
import type { AurumApi, ContextSnapshot } from '../../../shared';
import { Chip, EmptyState, Section } from './ui';

const fmt = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function Meta({ source, at, stale }: { source: string; at: number; stale?: boolean }) {
  return <span className="hint">{source} · fetched {new Date(at).toLocaleTimeString()} {stale && <Chip tone="warn" icon={AlertTriangle}>Stale</Chip>}</span>;
}
const Unavailable = ({ r }: { r: Extract<ConnectorResult<unknown>, { ok: false }> }) =>
  r.error.code === 'disabled' || r.error.code === 'not_configured'
    ? <EmptyState icon={Globe2} title="Not configured">Turn this connector on in Settings, Connectors.</EmptyState>
    : <Chip tone="danger" icon={AlertTriangle}>Unavailable: {r.error.message}</Chip>;

/** Live market context. Every block shows its source and fetch time; nothing is shown that a connector did not return. */
export function ContextPanel({ api, config }: { api: AurumApi | undefined; config: AppConfig | null }) {
  const [snap, setSnap] = useState<ContextSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const load = () => api.contextSnapshot().then((s) => alive && setSnap(s)).catch(() => undefined);
    void load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [api]);

  if (!api) return <EmptyState icon={Globe2} title="Open the Aurum desktop app" />;
  const live = sessionsSnapshot(config?.context.sessions ?? DEFAULT_SESSIONS_SETTINGS, now); // local clock, ticks every second
  const events = snap?.calendar.flatMap((s) => (s.result.ok ? s.result.data.items.map((e) => ({ ...e, stale: s.result.ok && s.result.stale })) : [])) ?? [];
  const upcoming = filterByImpact(events, 'high').filter((e) => e.time * 1000 >= now).sort((a, b) => a.time - b.time).slice(0, 8);

  return (
    <div className="scroll" style={{ display: 'grid', gap: 8, padding: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
      <Section title="Sessions">
        <Meta source="Aurum local clock" at={now} />
        <Chip tone={live.market.state === 'open' ? 'ok' : 'warn'} icon={Clock}>Gold market {live.market.state}{live.market.label ? ` (${live.market.label})` : ''}{live.market.changesAt ? ` · changes in ${formatDuration(live.market.changesAt - now)}` : ''}</Chip>
        {live.sessions.map((s) => (
          <div key={s.id} className="row"><strong>{s.name}</strong> <span className="hint">{s.localTime}</span> {s.active ? <Chip tone="ok">Open</Chip> : <Chip>Closed</Chip>}
            <span className="hint">{s.inHours && s.nextClose ? `closes in ${formatDuration(s.nextClose - now)}` : s.nextOpen ? `opens in ${formatDuration(s.nextOpen - now)}` : ''}</span></div>
        ))}
        {live.overlaps.filter((o) => o.active).map((o) => <Chip key={o.ids.join()} tone="gold">{o.names.join(' / ')} overlap · ends in {formatDuration(o.end - now)}</Chip>)}
      </Section>
      <Section title="High-impact events">
        {!snap?.calendar.length ? <EmptyState icon={CalendarClock} title="No calendar configured">Add a calendar feed in Settings, Connectors.</EmptyState>
          : snap.calendar.map((s) => !s.result.ok ? <div key={s.id}><Chip tone="danger" icon={AlertTriangle}>{s.name} unavailable: {s.result.error.message}</Chip></div> : <Meta key={s.id} source={s.name} at={s.result.fetchedAt} stale={s.result.stale} />)}
        {upcoming.map((e) => <div key={`${e.time}${e.title}`} className="row"><span className="hint">{fmt(e.time * 1000)}</span> <Chip>{e.currency}</Chip> {e.title} <span className="hint">f {e.forecast ?? '-'} p {e.previous ?? '-'}</span></div>)}
      </Section>
      <Section title="News">
        {!snap?.news.length ? <EmptyState icon={Newspaper} title="No news configured" /> : snap.news.map((s) => !s.result.ok ? <div key={s.id}><Chip tone="danger" icon={AlertTriangle}>{s.name} unavailable: {s.result.error.message}</Chip></div> : (
          <div key={s.id}><Meta source={s.name} at={s.result.fetchedAt} stale={s.result.stale} />
            {s.result.data.items.slice().sort((a, b) => b.time - a.time).slice(0, 8).map((n) => <div key={n.time + n.title}><span className="hint">{fmt(n.time * 1000)}</span> {n.title}</div>)}</div>))}
      </Section>
      <Section title="Sentiment">
        {!snap?.sentiment.length ? <EmptyState icon={Gauge} title="No sentiment configured" /> : snap.sentiment.map((s) => !s.result.ok ? <div key={s.id}><Chip tone="danger" icon={AlertTriangle}>{s.name} unavailable: {s.result.error.message}</Chip></div> : (
          <div key={s.id}><Meta source={s.name} at={s.result.fetchedAt} stale={s.result.stale} />
            {s.result.data.items.map((r) => <div key={r.instrument} className="row"><strong>{r.instrument}</strong> long {r.longPct}% / short {r.shortPct}% <span className="hint">as of {r.asOf ? fmt(r.asOf * 1000) : 'unknown'}</span></div>)}</div>))}
      </Section>
      <Section title="Related markets">
        {!snap ? null : !snap.related.ok ? <Unavailable r={snap.related} /> : (
          <>
            <Meta source={snap.related.source} at={snap.related.fetchedAt} stale={snap.related.stale} />
            {snap.related.data.quotes.map((q) => <div key={q.role} className="row"><strong>{q.label}</strong> <span className="mono">{q.ok ? q.last?.toFixed(3) : 'unavailable'}</span> {q.changePct !== null && <span className="hint">{q.changePct >= 0 ? '+' : ''}{q.changePct.toFixed(2)}%</span>} {!q.ok && <span className="hint">{q.error}</span>}</div>)}
          </>
        )}
      </Section>
    </div>
  );
}
