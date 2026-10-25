/** A plain-language health audit of every part of the app, computed from facts the app already has. No guessing: unknown is reported as unknown. */
export type HealthLevel = 'ok' | 'warn' | 'bad' | 'off';
export interface HealthCheck { id: string; area: 'Market data' | 'Trading' | 'AI' | 'WhatsApp' | 'Connectors' | 'Learning'; level: HealthLevel; text: string; fix?: string }

export interface EcosystemInput {
  feed: { state: string; tickAgeMs: number | null };
  account: { demo: boolean } | null;
  tradingEnabled: boolean;
  assistantEnabled: boolean;
  ai: { provider: string | null; hasKey: boolean; model: string; vision: boolean; secureStorage: boolean };
  whatsapp: { hasToken: boolean; state: string; linked: boolean; lastError: string | null; remotePaused: boolean } | null;
  connectors: { name: string; enabled: boolean; configured: boolean; issues: string[]; error: string | null; stale: boolean }[];
  learning: { recordTicks: boolean; ticks: number; memory: boolean; paperFinished: number; paperOpen: number };
}

export function auditEcosystem(i: EcosystemInput): HealthCheck[] {
  const out: HealthCheck[] = [];
  const add = (c: HealthCheck) => out.push(c);

  if (i.feed.state !== 'connected') add({ id: 'feed', area: 'Market data', level: 'bad', text: `MT5 feed is ${i.feed.state}.`, fix: 'Open MT5, attach AurumBridge to an XAUUSD chart and allow its WebSocket/WebRequest address.' });
  else if (i.feed.tickAgeMs !== null && i.feed.tickAgeMs > 60_000) add({ id: 'feed', area: 'Market data', level: 'warn', text: `Connected, but the last price is ${Math.round(i.feed.tickAgeMs / 1000)} s old (market closed or MT5 frozen).`, fix: 'Check the MT5 terminal shows moving prices.' });
  else add({ id: 'feed', area: 'Market data', level: 'ok', text: 'Live prices are arriving.' });

  if (!i.account) add({ id: 'account', area: 'Trading', level: 'warn', text: 'No account information from MT5 yet.' });
  else if (!i.account.demo) add({ id: 'account', area: 'Trading', level: 'bad', text: 'The MT5 account is NOT a demo account. Aurum refuses to trade on it.', fix: 'Log MT5 into a demo account.' });
  else add({ id: 'account', area: 'Trading', level: 'ok', text: 'Demo account connected.' });
  add({ id: 'trading', area: 'Trading', level: i.tradingEnabled ? 'ok' : 'off', text: i.tradingEnabled ? 'Order placing is enabled (demo, with risk rules).' : 'Order placing is off (read-only).' });
  add({ id: 'assistant', area: 'Trading', level: i.assistantEnabled ? 'ok' : 'off', text: i.assistantEnabled ? 'Trade Assistant is on.' : 'Trade Assistant is off; nothing automatic happens.' });

  if (!i.ai.provider) add({ id: 'ai', area: 'AI', level: 'bad', text: 'No AI provider chosen.', fix: 'Settings > AI: choose a provider and model.' });
  else if (!i.ai.hasKey) add({ id: 'ai', area: 'AI', level: 'bad', text: `No API key saved for ${i.ai.provider}.`, fix: 'Settings > AI: paste the key.' });
  else if (!i.ai.model) add({ id: 'ai', area: 'AI', level: 'warn', text: 'No model chosen.', fix: 'Settings > AI: Load models and pick one.' });
  else add({ id: 'ai', area: 'AI', level: 'ok', text: `${i.ai.provider} / ${i.ai.model} ready${i.ai.vision ? ' (can read chart pictures)' : ' (cannot read pictures; chart screenshots are sent to you only)'}.` });
  if (!i.ai.secureStorage) add({ id: 'secure', area: 'AI', level: 'warn', text: 'The operating system secure storage is unavailable; keys cannot be saved safely.' });

  if (i.whatsapp) {
    const w = i.whatsapp;
    if (!w.hasToken) add({ id: 'wa', area: 'WhatsApp', level: 'off', text: 'WhatsApp is not set up.' });
    else if (w.state === 'auth_error') add({ id: 'wa', area: 'WhatsApp', level: 'bad', text: 'WhatsApp token was rejected.', fix: 'Settings > WhatsApp: save a fresh token (rotate it if it was ever shared).' });
    else if (w.state === 'conflict') add({ id: 'wa', area: 'WhatsApp', level: 'bad', text: 'Another program is using the same WhatsApp token.', fix: 'Stop the other client or use a new token.' });
    else if (w.state !== 'polling') add({ id: 'wa', area: 'WhatsApp', level: 'warn', text: `WhatsApp gateway is ${w.state}${w.lastError ? `: ${w.lastError}` : ''}.` });
    else if (!w.linked) add({ id: 'wa', area: 'WhatsApp', level: 'warn', text: 'Gateway works but no phone is paired.', fix: 'Settings > WhatsApp: start pairing.' });
    else add({ id: 'wa', area: 'WhatsApp', level: 'ok', text: 'WhatsApp connected and paired.' });
    if (w.remotePaused) add({ id: 'wa-paused', area: 'WhatsApp', level: 'warn', text: 'Remote control from WhatsApp is paused (/pause).', fix: 'Send /resume from the paired phone.' });
  }

  const active = i.connectors.filter((c) => c.enabled);
  if (!active.length) add({ id: 'conn', area: 'Connectors', level: 'off', text: 'No data connectors enabled.' });
  for (const c of active) {
    if (!c.configured || c.issues.length) add({ id: `conn-${c.name}`, area: 'Connectors', level: 'warn', text: `${c.name}: ${c.issues[0] ?? 'not fully configured'}.`, fix: 'Settings > Connectors.' });
    else if (c.error) add({ id: `conn-${c.name}`, area: 'Connectors', level: 'warn', text: `${c.name}: last refresh failed (${c.error}).` });
    else if (c.stale) add({ id: `conn-${c.name}`, area: 'Connectors', level: 'warn', text: `${c.name}: data is stale.` });
    else add({ id: `conn-${c.name}`, area: 'Connectors', level: 'ok', text: `${c.name}: healthy.` });
  }

  add({ id: 'ticks', area: 'Learning', level: i.learning.recordTicks ? (i.learning.ticks > 0 ? 'ok' : 'warn') : 'off', text: i.learning.recordTicks ? `${i.learning.ticks.toLocaleString()} ticks recorded.` : 'Tick recording is off, so paper trades cannot be judged or replayed.', ...(i.learning.recordTicks ? {} : { fix: 'Settings > Trading > Learning.' }) });
  add({ id: 'paper', area: 'Learning', level: 'ok', text: `${i.learning.paperFinished} paper trades judged, ${i.learning.paperOpen} running.` });
  add({ id: 'memory', area: 'Learning', level: i.learning.memory ? 'ok' : 'off', text: i.learning.memory ? 'Chat memory is on.' : 'Chat memory is off.' });
  return out;
}

/** Transient provider failures worth retrying: rate limits, overload and gateway errors. Never auth or bad-request errors. */
export const isTransientStatus = (s: number) => s === 408 || s === 425 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504 || s === 529;

/** Wait before retry number `attempt` (0-based): honours Retry-After (seconds), otherwise 1 s, 2 s, 4 s with jitter; capped at 20 s. */
export function retryDelayMs(attempt: number, retryAfter: string | null, rand: () => number = Math.random): number {
  const secs = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : null;
  if (secs !== null) return Math.min(20_000, Math.max(0, secs * 1000));
  return Math.min(20_000, 1000 * 2 ** attempt + Math.floor(rand() * 400));
}
