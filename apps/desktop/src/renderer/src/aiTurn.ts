import { captureChart } from './lib/chartCapture';
import { gatherChecklist } from './lib/pretrade';
import {
  AiPermissionsSchema, NoTradeRuleSchema, UserViewSchema, type AiView, buildSystemPrompt, runAgent, runAiTool, toolCatalog,
  type AccountInfo, type AgentResult, type AlertCommand, type PrepareResult, type ChartControl, type IndicatorStore, type AiPermissions, type AppConfig, type ChartState, type ChatMessage, type ContractSpec, type DrawingStore,
  type FeedStatus, type Tick, type Timeframe,
} from '@aurum/core';
import type { AurumApi } from '../../shared';

export interface ChatDeps {
  api: AurumApi | undefined;
  config: AppConfig | null;
  store: DrawingStore;
  tf: Timeframe;
  tick: Tick | null;
  status: FeedStatus;
  account: AccountInfo | null;
  spec: ContractSpec | null;
  selectedId: string | null;
  paused: boolean;
  /** The chat panel supplies this so an AI order preview is shown to the user as a confirm dialog. Absent (e.g. WhatsApp) = no order tool. */
  onOrderProposal?: (p: PrepareResult) => void;
  indicators?: IndicatorStore;
  chart?: ChartControl;
  layout?: { layout: 'single' | 'two' | 'four'; paneTimeframes: Timeframe[]; activePane: number; syncScroll: boolean };
}

const DENIED = AiPermissionsSchema.parse({ chartRead: false });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function chartState(c: ChatDeps): ChartState {
  return {
    symbol: c.config?.symbol ?? 'XAUUSD', brokerSymbol: c.config?.brokerSymbol ?? '', timeframe: c.tf,
    feed: `${c.status.state}${c.status.message ? ` (${c.status.message})` : ''}`,
    bid: c.tick?.bid ?? null, ask: c.tick?.ask ?? null, spread: c.tick?.spread ?? null, tickTime: c.tick?.time ?? null,
    account: c.account ? { demo: c.account.demo, currency: c.account.currency, balance: c.account.balance, equity: c.account.equity } : null,
    selectedDrawingId: c.selectedId, pipSize: c.config?.pipSize ?? 0.1,
    ...(c.layout ? { layout: c.layout.layout, paneTimeframes: c.layout.paneTimeframes, activePane: c.layout.activePane, syncScroll: c.layout.syncScroll } : {}),
  };
}

/** The AI's permissions: the configured ones, or none while "stop AI actions" is on. */
export const perms = (c: ChatDeps): AiPermissions => (c.paused ? DENIED : AiPermissionsSchema.parse(c.config?.aiPermissions ?? {}));

export function contextLine(c: ChatDeps): string {
  const s = chartState(c);
  const all = c.store.list();
  return `[context] ${s.symbol} (${s.brokerSymbol}) ${s.timeframe} | bid ${s.bid ?? 'n/a'} ask ${s.ask ?? 'n/a'} | feed ${c.status.state} | selected drawing: ${s.selectedDrawingId ?? 'none'} | drawings: ${all.length} (AI ${all.filter((x) => x.layer === 'ai').length})`;
}

export interface TurnOpts {
  /** False when the chosen model cannot read images: pictures still go to the user but not to the model. */
  canSeeImages?: boolean;
  /** Pictures produced by tools (chart screenshots), e.g. to forward to WhatsApp. */
  onImages?: (images: { mime: string; data: string }[]) => void;
  /** Extra tool definitions (name, description, JSON schema) that only `intercept` handles. */
  extraTools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  channel?: 'app' | 'whatsapp';
  signal?: AbortSignal;
  /** Request id of each provider call (so a running call can be aborted). */
  onRequest?: (id: string) => void;
  onMessage?: (m: ChatMessage) => void;
  onEvent?: Parameters<typeof runAgent>[1]['onEvent'];
  /** Return a result to answer a tool call WITHOUT running it (used to hold chart changes for confirmation). */
  intercept?: (name: string, input: unknown) => { ok: boolean; content: string } | null;
}

/** One agent turn over `history` (which already ends with the user message). Shared by the chat panel and the WhatsApp headless runner. */
const planSummary = (p: { side: string; zone: { low: number; high: number }; entry: string; slPips: number; tpPips: number | null; riskPct: number; note: string }) =>
  `${p.side.toUpperCase()} ${p.entry === 'limit' ? 'limit at' : 'when price reaches'} ${p.zone.low}-${p.zone.high}: stop ${p.slPips} pips${p.tpPips ? `, target ${p.tpPips} pips` : ''}, risk ${p.riskPct}%${p.note ? `. ${p.note}` : ''}`;

function parseKv<T>(json: string | null, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
  if (!json) return null;
  try { const r = schema.safeParse(JSON.parse(json)); return r.success ? r.data : null; } catch { return null; }
}

export async function runTurn(st: () => ChatDeps, history: ChatMessage[], p: AiPermissions, opts: TurnOpts = {}): Promise<AgentResult> {
  const caps = await st().api?.aiCaps().catch(() => null);
  const o: TurnOpts = { ...opts, ...(opts.canSeeImages === undefined && caps ? { canSeeImages: caps.vision } : {}) };
  const toolCtx = () => ({
    store: st().store, indicators: st().indicators, chart: st().chart, permissions: p, getState: () => chartState(st()),
    ...(st().onOrderProposal && st().config && st().api ? { orders: {
      orderMode: p.orders, maxRiskPerTradePct: st().config!.risk.maxRiskPerTradePct, symbol: st().config!.brokerSymbol,
      positions: async () => (await st().api!.ordersState()).positions,
      checklist: async (res: Parameters<NonNullable<import('@aurum/core').OrdersPort['checklist']>>[0]) => { const cfg = st().config; const a = st().api; if (!cfg || !a) return null; const t = st().tick; return gatherChecklist(a, cfg, res, t ? { bid: t.bid, ask: t.ask } : null); },
      propose: async (cmd: unknown) => { const res = await st().api!.ordersPrepare(cmd); if (res.ok && 'preview' in res) st().onOrderProposal?.(res); return res; },
    } } : {}),
    alerts: { snapshot: () => st().api!.alertsSnapshot(), dispatch: (c: AlertCommand) => st().api!.alertsDispatch(c) },
    getCandles: (tf: Timeframe, n: number) => st().api!.candles(tf, n),
    captureChart,
    paper: { record: (i: Parameters<NonNullable<import('@aurum/core').ToolContext['paper']>['record']>[0]) => st().api!.paperRecord(i as never) },
    plans: {
      defaults: () => { const d = st().config?.assistant.defaults; return { slPips: d?.slPips ?? 70, tpPips: d?.tpPips ?? 140, riskPct: d?.riskPct ?? 0.3, expiryHours: d?.expiryHours ?? 24 }; },
      create: async (i: { side: 'buy' | 'sell'; zone: { low: number; high: number }; entry: 'touch' | 'limit'; slPips: number; tpPips: number | null; riskPct: number; expiryHours: number; note: string }) => {
        const p = await st().api!.assistCreate(i);
        return { id: p.id, status: p.status, summary: planSummary(p) };
      },
      list: async () => (await st().api!.assistList()).map((p) => ({ id: p.id, status: p.status, summary: planSummary(p), detail: p.statusDetail })),
      cancel: async (id: string) => { await st().api!.assistCancel(id); },
      positions: () => st().api!.assistPips(),
    },
    views: {
      getMine: async () => parseKv(await st().api!.kvGet('user_view'), UserViewSchema),
      getAi: async () => { try { const j = await st().api!.kvGet('ai_view'); return j ? (JSON.parse(j) as AiView) : null; } catch { return null; } },
      saveAi: (v: AiView) => st().api!.kvSet('ai_view', JSON.stringify(v)),
    },
    deals: (days: number) => st().api!.ordersHistory(days),
    getSpec: () => st().spec, startOfToday,
    context: {
      getSessions: () => st().api!.contextRead('sessions'),
      getFeeds: (k: 'calendar' | 'news' | 'sentiment') => st().api!.contextRead(k) as Promise<never>,
      getRelated: () => st().api!.contextRead('related'),
      noTrade: st().config?.context.noTrade ?? NoTradeRuleSchema.parse({}),
    }, exposeBalance: st().config?.ai.sendBalance ?? false,
  });
  const s = chartState(st());
  const system = buildSystemPrompt({ symbol: s.symbol, brokerSymbol: s.brokerSymbol, readOnly: !p.drawingsEdit && !p.alertsAndSetups, canDraw: p.drawingsEdit, canAlert: p.alertsAndSetups, orderMode: p.orders, ...(o.channel ? { channel: o.channel } : {}) });
  const api = st().api!;
  return runAgent(history, {
    system, tools: [...toolCatalog(p), ...(o.extraTools ?? [])], ...(o.signal ? { signal: o.signal } : {}),
    llm: (req) => { const id = crypto.randomUUID(); o.onRequest?.(id); return api.aiChat(id, req); },
    exec: async (name, input) => {
      const held = o.intercept?.(name, input);
      if (held) return held;
      const res = await runAiTool(toolCtx(), name, input);
      const { images, ...plain } = res as typeof res & { images?: { mime: string; data: string }[] };
      if (images?.length) o.onImages?.(images);
      if (images?.length && o.canSeeImages === false) {
        return { ok: res.ok, content: JSON.stringify({ ...plain, data: { ...(plain as { data?: object }).data, note: 'The picture was sent to the user. This model cannot see images, so do not describe it; use get_candles and find_zones for facts.' } }) };
      }
      return { ok: res.ok, content: JSON.stringify(plain), ...(images?.length ? { images } : {}) };
    },
    ...(o.onMessage ? { onMessage: o.onMessage } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
  });
}

/** Executes already-confirmed tool calls against the live stores (same functions the chat uses). */
export async function execConfirmed(st: () => ChatDeps, calls: { name: string; input: unknown }[]): Promise<{ ok: boolean; text: string }> {
  const c = st();
  const p = AiPermissionsSchema.parse(c.config?.aiPermissions ?? {});
  if (c.paused) return { ok: false, text: 'AI actions are paused in the app.' };
  const out: string[] = [];
  let ok = true;
  for (const call of calls) {
    const res = await runAiTool({
      store: c.store, permissions: p, getState: () => chartState(st()), getCandles: (tf, n) => st().api!.candles(tf, n), getSpec: () => st().spec, startOfToday,
    }, call.name, call.input);
    if (!res.ok) ok = false;
    out.push(res.ok ? `${call.name}: done` : `${call.name}: ${res.error}`);
  }
  return { ok, text: ok ? `Done. ${out.join('; ')}` : `Some steps failed. ${out.join('; ')}` };
}
