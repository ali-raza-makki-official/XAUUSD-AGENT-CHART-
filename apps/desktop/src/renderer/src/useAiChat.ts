import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AiPermissionsSchema, NoTradeRuleSchema, buildSystemPrompt, repairHistory, runAgent, runAiTool, toolCatalog,
  type AccountInfo, type ChartControl, type IndicatorStore, type AppConfig, type ChartState, type ChatMessage, type ContractSpec, type DrawingStore,
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
  indicators?: IndicatorStore;
  chart?: ChartControl;
  layout?: { layout: 'single' | 'two' | 'four'; paneTimeframes: Timeframe[]; activePane: number; syncScroll: boolean };
}

const MAX_SAVED = 120;
const DENIED = AiPermissionsSchema.parse({ chartRead: false });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function useAiChat(deps: ChatDeps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const d = useRef(deps);
  d.current = deps;
  const msgs = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const reqId = useRef<string>('');

  const commit = useCallback((next: ChatMessage[]) => { msgs.current = next; setMessages(next); }, []);

  useEffect(() => {
    void deps.api?.loadChat().then((j) => {
      if (!j) return;
      try { commit(repairHistory(JSON.parse(j) as ChatMessage[])); } catch { /* ignore a corrupt saved chat */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.api]);

  const save = useCallback(() => {
    void d.current.api?.saveChat(JSON.stringify(repairHistory(msgs.current).slice(-MAX_SAVED))).catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    if (reqId.current) void d.current.api?.aiAbort(reqId.current);
  }, []);

  // "Stop AI actions": halts the running turn immediately.
  useEffect(() => { if (deps.paused) stop(); }, [deps.paused, stop]);

  const send = useCallback(async (text: string) => {
    const { api, config } = d.current;
    if (!api || !config || !text.trim() || running) return;
    setError(null);
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);

    const st = () => d.current;
    const state = (): ChartState => {
      const c = st();
      return {
        symbol: c.config?.symbol ?? 'XAUUSD', brokerSymbol: c.config?.brokerSymbol ?? '', timeframe: c.tf,
        feed: `${c.status.state}${c.status.message ? ` (${c.status.message})` : ''}`,
        bid: c.tick?.bid ?? null, ask: c.tick?.ask ?? null, spread: c.tick?.spread ?? null, tickTime: c.tick?.time ?? null,
        account: c.account ? { demo: c.account.demo, currency: c.account.currency, balance: c.account.balance, equity: c.account.equity } : null,
        selectedDrawingId: c.selectedId, pipSize: c.config?.pipSize ?? 0.1,
        ...(c.layout ? { layout: c.layout.layout, paneTimeframes: c.layout.paneTimeframes, activePane: c.layout.activePane, syncScroll: c.layout.syncScroll } : {}),
      };
    };
    const perms = () => (st().paused ? DENIED : AiPermissionsSchema.parse(st().config?.aiPermissions ?? {}));
    const toolCtx = () => ({
      store: st().store, indicators: st().indicators, chart: st().chart, permissions: perms(), getState: state,
      getCandles: (tf: Timeframe, n: number) => st().api!.candles(tf, n),
      getSpec: () => st().spec, startOfToday,
      context: {
        getSessions: () => st().api!.contextRead('sessions'),
        getFeeds: (k: 'calendar' | 'news' | 'sentiment') => st().api!.contextRead(k) as Promise<never>,
        getRelated: () => st().api!.contextRead('related'),
        noTrade: st().config?.context.noTrade ?? NoTradeRuleSchema.parse({}),
      }, exposeBalance: st().config?.ai.sendBalance ?? false,
    });

    const s = state();
    const all = st().store.list();
    const context = `[context] ${s.symbol} (${s.brokerSymbol}) ${s.timeframe} | bid ${s.bid ?? 'n/a'} ask ${s.ask ?? 'n/a'} | feed ${st().status.state} | selected drawing: ${s.selectedDrawingId ?? 'none'} | drawings: ${all.length} (AI ${all.filter((x) => x.layer === 'ai').length})`;
    commit([...msgs.current, { role: 'user', blocks: [{ type: 'text', text: `${context}\n\n${text.trim()}` }] }]);

    const p = perms();
    const system = buildSystemPrompt({ symbol: s.symbol, brokerSymbol: s.brokerSymbol, readOnly: !p.drawingsEdit && !p.alertsAndSetups, canDraw: p.drawingsEdit, orderMode: p.orders });
    try {
      const r = await runAgent(msgs.current, {
        system, tools: toolCatalog(p), signal: ac.signal,
        llm: (req) => { reqId.current = crypto.randomUUID(); return api.aiChat(reqId.current, req); },
        exec: async (name, input) => {
          const res = await runAiTool(toolCtx(), name, input);
          return { ok: res.ok, content: JSON.stringify(res) };
        },
        onMessage: (m) => commit([...msgs.current, m]),
        onEvent: (e) => e.type === 'usage' && setUsage((u) => ({ input: u.input + e.input, output: u.output + e.output })),
      });
      if (r.ended === 'error') setError(r.error ?? 'The AI request failed.');
      if (r.ended === 'max_steps') setError('The AI used all its steps without finishing. Ask again, or narrow the request.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      commit(repairHistory(msgs.current).length === msgs.current.length ? msgs.current : repairHistory(msgs.current));
      setRunning(false);
      save();
    }
  }, [commit, running, save]);

  const clear = useCallback(() => { stop(); commit([]); setError(null); save(); }, [commit, save, stop]);

  return { messages, running, error, usage, send, stop, clear };
}
