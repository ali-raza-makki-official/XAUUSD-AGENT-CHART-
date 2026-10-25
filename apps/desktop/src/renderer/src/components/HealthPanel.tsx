import { useCallback, useEffect, useRef, useState } from 'react';
import { HeartPulse, RefreshCw } from 'lucide-react';
import { auditEcosystem, type AppConfig, type FeedStatus, type HealthCheck, type Tick, type AccountInfo } from '@aurum/core';
import type { AurumApi } from '../../../shared';
import { Button, EmptyState } from './ui';

const COLOR: Record<HealthCheck['level'], string> = { ok: 'var(--buy)', warn: 'var(--warn)', bad: 'var(--sell)', off: 'var(--t2)' };
const WORD: Record<HealthCheck['level'], string> = { ok: 'OK', warn: 'Check', bad: 'Problem', off: 'Off' };

/** One screen that answers "is every part working?": market data, trading, AI, WhatsApp, connectors, learning. */
export function HealthPanel({ api, config, status, tick, account }: { api?: AurumApi; config?: AppConfig | null; status: FeedStatus; tick: Tick | null; account: AccountInfo | null }) {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const lastTickAt = useRef<number | null>(null);
  useEffect(() => { if (tick) lastTickAt.current = Date.now(); }, [tick]);

  const run = useCallback(async () => {
    if (!api || !config) return;
    const [ai, caps, wa, ctx, ins] = await Promise.all([api.aiStatus().catch(() => null), api.aiCaps().catch(() => null), api.waStatus().catch(() => null), api.contextStatus().catch(() => []), api.learnInsights().catch(() => null)]);
    const p = config.ai.provider;
    setChecks(auditEcosystem({
      feed: { state: status.state, tickAgeMs: lastTickAt.current ? Date.now() - lastTickAt.current : null },
      account: account ? { demo: account.demo } : null,
      tradingEnabled: config.trading.enabled, assistantEnabled: config.assistant.enabled,
      ai: { provider: p, hasKey: !!(p && ai?.hasKey[p]), model: caps?.model ?? '', vision: !!caps?.vision, secureStorage: ai?.secureStorage ?? true },
      whatsapp: wa ? { hasToken: wa.hasToken, state: wa.state, linked: wa.link.status === 'linked', lastError: wa.lastError?.message ?? null, remotePaused: wa.remotePaused } : null,
      connectors: ctx.map((c) => ({ name: c.name, enabled: c.enabled, configured: c.configured, issues: c.issues, error: c.health.errorStatus?.message ?? null, stale: c.health.stale })),
      learning: { recordTicks: config.learning.recordTicks, ticks: ins?.ticks.count ?? 0, memory: config.learning.memory, paperFinished: ins?.finished ?? 0, paperOpen: ins?.open ?? 0 },
    }));
  }, [api, config, status.state, account]);
  useEffect(() => { void run(); const t = setInterval(() => void run(), 10_000); return () => clearInterval(t); }, [run]);

  if (!api) return <EmptyState icon={HeartPulse} title="Open the Aurum desktop app to see system health." />;
  const areas = [...new Set(checks.map((c) => c.area))];
  const problems = checks.filter((c) => c.level === 'bad' || c.level === 'warn').length;
  return (
    <div className="journal" aria-label="System health">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <b>{problems === 0 ? 'Everything that is switched on is working.' : `${problems} item(s) need attention.`}</b>
        <Button size="sm" icon={RefreshCw} onClick={() => void run()}>Re-check</Button>
      </div>
      {areas.map((a) => (
        <section key={a} aria-label={a}><h4>{a}</h4>
          {checks.filter((c) => c.area === a).map((c) => (
            <div key={c.id} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: COLOR[c.level], minWidth: 56, fontWeight: 600 }}>{WORD[c.level]}</span>
              <span>{c.text}{c.fix && <span className="hint"> {c.fix}</span>}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
