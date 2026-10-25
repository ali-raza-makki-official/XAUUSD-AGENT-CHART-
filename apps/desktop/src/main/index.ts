import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AssistantSettingsSchema, ChecklistSettingsSchema, LearningSettingsSchema, NotificationSettingsSchema, AiPermissionsSchema, AiSettingsSchema, ChartLayoutSchema, ContextSettingsSchema, RiskSettingsSchema, DrawingSchema, IndicatorSchema, PROVIDER_IDS, PaneTimeframesSchema, ProviderIdSchema, StyleSchema } from '@aurum/core';
import { TimeframeSchema, type AppConfig, type FeedStatus } from '@aurum/core';
import { startBackups } from './backup';
import { BridgeManager } from './bridge';
import { loadConfig, saveConfig } from './config';
import { makeTranscriber, voiceRoute } from './transcribe';
import { ConnectionWatcher } from './connectionWatch';
import { tickBriefing } from './briefingScheduler';
import { AssistantService, SqlitePlanStore, describePlan } from './assistant';
import { PaperService, SqlitePaperStore } from './paper';
import { TickStore } from './ticks';
import { LearningService } from './learning';
import { atLeast, closedTrades, composeBriefing, summarize, type AiView, type BriefingInput, type CalendarEvent, type NoTradeRule, type UserView } from '@aurum/core';
import { kvGet, kvSet, closeDb, loadChat, loadDrawings, loadIndicators, persist, persistIndicators, saveChat } from './db';
import * as llm from './llm';
import * as db from './db';
import { AlertService } from './alerts';
import { electronNotifier, registerAlertIpc } from './alertIpc';
import { initAutoUpdate } from './updater';
import { clearConnectorSecret, clearKey, getKey, hasKey, secureStorageAvailable, setConnectorSecret, setKey, clearWhatsAppToken, getWhatsAppToken, setWhatsAppToken } from './secrets';
import { getDb } from './db';
import { WhatsAppService } from './whatsappService';
import { OrderService } from './orders';
import { EaHub } from './eaHub';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SqliteWhatsAppStore } from './whatsappStore';
import { registerWhatsAppIpc } from './whatsappIpc';
import { ContextHub } from './contextHub';
import { IPC } from '../shared';

let config: AppConfig;
const bridge = new BridgeManager();
let hub: ContextHub;
let alerts: AlertService;
let wa: WhatsAppService;
let watcher: ConnectionWatcher | null = null;
let assistant: AssistantService | null = null;
let paper: PaperService | null = null;
let learning: LearningService | null = null;
let tickStore: TickStore | null = null;
let briefingTimer: ReturnType<typeof setInterval> | null = null;

/** Real data for the morning briefing. Anything that cannot be read is passed as null and left out of the text. */
async function briefingInput(): Promise<BriefingInput> {
  const nowMs = Date.now();
  const [sessionsRes, snap, state, deals] = await Promise.all([
    hub.read('sessions').catch(() => null), hub.snapshot().catch(() => null), orders.state().catch(() => null), orders.history(2).catch(() => null),
  ]);
  const feeds = snap?.calendar.filter((c) => c.result.ok) ?? [];
  const events = feeds.length
    ? noTradeEventsToday(feeds.flatMap((c) => (c.result.ok ? c.result.data.items : [])), config.context.noTrade, nowMs)
    : null;
  const day = deals ? summarize(closedTrades(deals).filter((t) => t.closeTime * 1000 >= nowMs - 86_400_000)) : null;
  const parse = <T>(k: 'user_view' | 'ai_view'): T | null => { try { const j = kvGet(k); return j ? (JSON.parse(j) as T) : null; } catch { return null; } };
  return {
    nowMs, symbol: config.symbol, tick: bridge.lastTick ? { bid: bridge.lastTick.bid, ask: bridge.lastTick.ask } : null,
    sessions: sessionsRes && sessionsRes.ok ? sessionsRes.data : null, events,
    openPositions: state ? state.positions.filter((p) => p.symbol === config.brokerSymbol).map((p) => ({ side: p.type === 'buy' ? 'buy' as const : 'sell' as const, volume: p.volume, sl: p.sl ?? null, tp: p.tp ?? null, profit: p.profit })) : null,
    yesterday: day ? { trades: day.trades, net: day.net, wins: day.wins } : null,
    currency: state?.account?.currency ?? 'USD', myView: parse<UserView>('user_view'), aiView: parse<AiView>('ai_view'), showMoney: true, tz: wa.briefing().tz,
  };
}

/** High-impact events (by the user's no-trade rule) in the next 18 hours. */
function noTradeEventsToday(events: CalendarEvent[], rule: NoTradeRule, nowMs: number): CalendarEvent[] {
  return events.filter((e) => e.time * 1000 >= nowMs - 3600_000 && e.time * 1000 <= nowMs + 18 * 3600_000 && atLeast(e.impact, rule.minImpact) && rule.currencies.includes(e.currency)).sort((a, b) => a.time - b.time);
}
let orders: OrderService;
let eaHub: EaHub | null = null;

async function ensureEaHub(): Promise<EaHub> {
  if (eaHub) return eaHub;
  const file = join(app.getPath('userData'), 'ea-token.txt');
  let token = '';
  try { token = readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  if (token.length < 16) { token = randomBytes(18).toString('hex'); writeFileSync(file, token, { mode: 0o600 }); }
  eaHub = new EaHub(8766, token);
  await eaHub.start();
  return eaHub;
}

/** Starts the MT5 connection: the EA hub, and the poller that reads it. */
async function startFeed(): Promise<void> {
  const hub = await ensureEaHub();
  hub.config(config.brokerSymbol, config.trading.enabled);
  await bridge.start({ port: hub.httpPort, token: hub.httpToken });
}
let win: BrowserWindow | null = null;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0E1013',
    title: 'Aurum',
    // Themed title bar: the native frame is hidden, the top bar of the app is the drag area and Windows draws only the
    // min/max/close buttons, in the app colours (height matches the 44px top bar).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#14171b', symbolColor: '#a3abb5', height: 44 } }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged, // no DevTools / inspector in the shipped app
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // F11: real full screen of the whole window (the chart has its own in-app full screen button).
  win.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'F11' && win) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); } });
  win.webContents.on('did-start-loading', () => wa?.setAiReady(false)); // the renderer re-announces itself once mounted
  // Navigation controls: the app never navigates away or opens windows; external links go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/')).href)) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

function registerIpc(): void {
  ipcMain.handle(IPC.getConfig, () => config);
  ipcMain.handle(IPC.setConfig, async (_e, patch: unknown) => {
    const allowed = z
      .object({
        brokerSymbol: z.string().min(1).max(32),
        trading: z.object({ enabled: z.boolean() }),
        risk: RiskSettingsSchema,
        pipSize: z.number().positive(),
        timeframe: TimeframeSchema,
        toolStyles: z.record(z.string(), StyleSchema.partial()),
        magnet: z.boolean(),
        stayInTool: z.boolean(),
        aiPermissions: AiPermissionsSchema,
        ai: AiSettingsSchema,
        layout: ChartLayoutSchema,
        paneTimeframes: PaneTimeframesSchema,
        syncScroll: z.boolean(),
        context: ContextSettingsSchema,
        notifications: NotificationSettingsSchema,
        checklist: ChecklistSettingsSchema,
        assistant: AssistantSettingsSchema,
        learning: LearningSettingsSchema,
      })
      .partial()
      .parse(patch);
    const symbolChanged = (allowed.brokerSymbol !== undefined && allowed.brokerSymbol !== config.brokerSymbol) || (allowed.trading !== undefined && allowed.trading.enabled !== config.trading.enabled);
    config = saveConfig(allowed, config);
    if (allowed.context) hub.sync();
    if (symbolChanged) await startFeed();
    return config;
  });
  ipcMain.handle(IPC.candles, (_e, tf: unknown, count: unknown) =>
    bridge.candles(TimeframeSchema.parse(tf), z.number().int().min(1).max(5000).parse(count)),
  );
  ipcMain.handle(IPC.findSymbols, (_e, q: unknown) => bridge.findSymbols(z.string().max(64).parse(q)));
  ipcMain.handle(IPC.symbolSpec, () => bridge.symbolSpec());
  ipcMain.handle(IPC.loadDrawings, (_e, symbol: unknown) => loadDrawings(z.string().min(1).max(32).parse(symbol)));
  ipcMain.handle(IPC.persistDrawings, (_e, raw: unknown) => {
    const p = z
      .object({
        symbol: z.string().min(1).max(32),
        log: z.object({ commandId: z.string().min(8), actor: z.enum(['manual', 'ai']), kind: z.enum(['do', 'undo', 'redo']), label: z.string().max(200) }),
        changes: z.array(z.object({ id: z.string().min(1), after: DrawingSchema.nullable() })).max(500),
      })
      .parse(raw);
    persist(p);
    alerts.refreshDrawings(); // alert conditions reference drawing ids
  });
  ipcMain.handle(IPC.loadIndicators, (_e, symbol: unknown) => loadIndicators(z.string().min(1).max(32).parse(symbol)));
  ipcMain.handle(IPC.persistIndicators, (_e, raw: unknown) => {
    const p = z
      .object({
        symbol: z.string().min(1).max(32),
        log: z.object({ commandId: z.string().min(8), actor: z.enum(['manual', 'ai']), kind: z.enum(['do', 'undo', 'redo']), label: z.string().max(200) }),
        changes: z.array(z.object({ id: z.string().min(1), after: IndicatorSchema.nullable() })).max(500),
      })
      .parse(raw);
    persistIndicators(p);
  });
  const provider = (v: unknown) => ProviderIdSchema.parse(v);
  ipcMain.handle(IPC.aiStatus, () => ({
    secureStorage: secureStorageAvailable(),
    hasKey: Object.fromEntries(PROVIDER_IDS.map((p) => [p, hasKey(p)])),
  }));
  ipcMain.handle(IPC.aiSetKey, (_e, p: unknown, k: unknown) => setKey(provider(p), z.string().min(8).max(500).parse(k)));
  ipcMain.handle(IPC.aiClearKey, (_e, p: unknown) => clearKey(provider(p)));
  ipcMain.handle(IPC.aiListModels, (_e, p: unknown) => llm.listModels(config, provider(p)));
  ipcMain.handle(IPC.aiCaps, () => {
    const { provider, model, caps } = llm.activeCaps(config);
    const route = voiceRoute({ getConfig: () => config, getKey });
    return { provider, model, ...caps, voice: { by: route ? route.by : null } };
  });
  ipcMain.handle(IPC.aiTest, (_e, p: unknown) => llm.test(config, provider(p)));
  ipcMain.handle(IPC.aiChat, (_e, id: unknown, req: unknown) => {
    const media = { mime: z.string().max(100), data: z.string().max(20_000_000) };
    const blocks = z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text') }).passthrough(),
      z.object({ type: z.literal('tool_call') }).passthrough(),
      z.object({ type: z.literal('tool_result') }).passthrough(),
      z.object({ type: z.literal('image'), ...media }),
      z.object({ type: z.literal('file'), name: z.string().max(200), ...media }),
    ]));
    const parsed = z.object({
      system: z.string().max(20000),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), blocks })).max(400),
      tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })).max(40),
      maxTokens: z.number().int().min(16).max(16000),
    }).parse(req);
    return llm.chat(config, z.string().min(1).max(64).parse(id), parsed as never);
  });
  ipcMain.handle(IPC.aiAbort, (_e, id: unknown) => llm.abort(z.string().parse(id)));
  const kindId = z.enum(['sessions', 'calendar', 'news', 'sentiment', 'related']);
  const known = (v: unknown) => { const id = z.string().min(2).max(64).parse(v); if (!hub.registry.has(id) || id === 'sessions' || id === 'related-markets') throw new Error('Unknown connector.'); return id; };
  ipcMain.handle(IPC.contextSnapshot, (_e, force: unknown) => hub.snapshot(force === true));
  ipcMain.handle(IPC.contextRead, (_e, k: unknown, force: unknown) => hub.read(kindId.parse(k), force === true));
  ipcMain.handle(IPC.contextStatus, () => hub.status());
  ipcMain.handle(IPC.contextTest, (_e, id: unknown) => hub.test(z.string().min(2).max(64).parse(id)));
  ipcMain.handle(IPC.contextRefresh, () => hub.refresh(true));
  ipcMain.handle(IPC.contextSetSecret, (_e, id: unknown, v: unknown) => setConnectorSecret(known(id), z.string().min(1).max(2000).parse(v)));
  ipcMain.handle(IPC.contextClearSecret, (_e, id: unknown) => clearConnectorSecret(known(id)));
  ipcMain.handle(IPC.loadChat, () => loadChat());
  ipcMain.handle(IPC.saveChat, (_e, j: unknown) => saveChat(z.string().max(5_000_000).parse(j)));
  ipcMain.handle(IPC.ordersState, () => orders.state());
  ipcMain.handle(IPC.ordersPrepare, (_e, c: unknown) => orders.engine.prepare(c));
  ipcMain.handle(IPC.ordersConfirm, (_e, id: unknown) => orders.engine.confirm(z.string().min(8).max(80).parse(id)));
  ipcMain.handle(IPC.ordersReconcile, (_e, id: unknown) => orders.engine.reconcile(z.string().min(8).max(80).parse(id)));
  const checkSnap = z.object({
    items: z.array(z.object({ id: z.string().max(40), label: z.string().max(160), status: z.enum(['pass', 'fail', 'warn', 'unknown']) })).max(20),
    acknowledged: z.boolean(), ticked: z.array(z.string().max(40)).max(20),
  });
  ipcMain.handle(IPC.journalSaveCheck, (_e, id: unknown, snap: unknown) => orders.saveCheck(z.string().min(8).max(80).parse(id), checkSnap.parse(snap)));
  ipcMain.handle(IPC.journalChecks, () => orders.checks());
  const kvKey = z.enum(['user_view', 'ai_view']);
  ipcMain.handle(IPC.kvGet, (_e, k: unknown) => kvGet(kvKey.parse(k)));
  ipcMain.handle(IPC.kvSet, (_e, k: unknown, j: unknown) => kvSet(kvKey.parse(k), z.string().max(50_000).parse(j)));
  ipcMain.handle(IPC.autoStartGet, () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle(IPC.autoStartSet, (_e, on: unknown) => {
    const v = z.boolean().parse(on);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: v }); // a development run must not register itself with Windows
    return app.getLoginItemSettings().openAtLogin;
  });
  const planInput = z.object({
    side: z.enum(['buy', 'sell']), zone: z.object({ low: z.number().positive(), high: z.number().positive() }),
    entry: z.enum(['touch', 'limit']).optional(), slPips: z.number().positive().max(5000).optional(), tpPips: z.number().positive().max(5000).nullable().optional(),
    riskPct: z.number().positive().max(5).optional(), autoTake: z.boolean().optional(), expiryHours: z.number().positive().max(720).optional(), note: z.string().max(500).optional(),
  });
  const planId = z.string().min(8).max(80);
  ipcMain.handle(IPC.assistList, () => assistant!.list());
  ipcMain.handle(IPC.assistCreate, (_e, raw: unknown) => {
    const { expiryHours, ...i } = planInput.parse(raw);
    return assistant!.create({ ...i, createdBy: 'manual', ...(expiryHours ? { expiresAt: Date.now() + expiryHours * 3600_000 } : {}) } as never);
  });
  ipcMain.handle(IPC.assistApprove, (_e, id: unknown, auto: unknown) => assistant!.approve(planId.parse(id), { autoTake: z.boolean().parse(auto) }));
  ipcMain.handle(IPC.assistCancel, (_e, id: unknown) => assistant!.cancel(planId.parse(id)));
  ipcMain.handle(IPC.assistTake, (_e, id: unknown) => assistant!.take(planId.parse(id)));
  ipcMain.handle(IPC.assistSkip, (_e, id: unknown) => assistant!.skip(planId.parse(id)));
  ipcMain.handle(IPC.assistPips, async () => assistant!.pipsView(await orders.snapshot(), config.pipSize));
  ipcMain.handle(IPC.paperList, () => paper!.list());
  ipcMain.handle(IPC.learnInsights, (_e, force: unknown) => learning!.insights(force === true));
  ipcMain.handle(IPC.learnApply, (_e, sl: unknown, tp: unknown) => { learning!.apply(z.number().positive().max(2000).parse(sl), z.number().positive().max(5000).parse(tp), false, 'Applied by you from the Learning tab.'); return config; });
  ipcMain.handle(IPC.learnRevert, () => { const ok = learning!.revert(); return { ok, config }; });
  const paperIdea = z.object({
    source: z.enum(['analysis', 'user']), side: z.enum(['buy', 'sell']), zone: z.object({ low: z.number().positive(), high: z.number().positive() }).refine((zn) => zn.high > zn.low),
    slPips: z.number().positive().max(2000), tpPips: z.number().positive().max(5000).nullable(), entry: z.enum(['touch', 'limit']).default('touch'), note: z.string().max(300).default(''),
  });
  ipcMain.handle(IPC.paperRecord, (_e, raw: unknown) => {
    const i = paperIdea.parse(raw);
    const dup = paper!.similar(i.side, i.zone, i.source);
    if (dup) return dup;
    return paper!.create({ id: `paper-${i.source}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, source: i.source, side: i.side, entry: i.entry, zone: i.zone, slPips: i.slPips, tpPips: i.tpPips, note: i.note });
  });
  ipcMain.handle(IPC.tickStats, () => tickStore!.stats());
  ipcMain.handle(IPC.ordersHistory, (_e, days: unknown) => orders.history(z.number().int().min(1).max(365).parse(days)));
  ipcMain.handle(IPC.ordersKill, (_e, on: unknown) => orders.engine.setKillSwitch(z.boolean().parse(on)));
  ipcMain.handle(IPC.ordersActivity, () => orders.activity());
  ipcMain.handle(IPC.reconnect, () => startFeed());
  ipcMain.handle(IPC.eaInfo, async () => { const h = await ensureEaHub(); return { port: h.eaPort, token: h.eaToken, connected: h.connected }; });
  ipcMain.handle(IPC.snapshot, () => ({ status: bridge.status, tick: bridge.lastTick, account: bridge.account }));
  registerAlertIpc(ipcMain, alerts, send);
  bridge.on('tick', (t) => send(IPC.tick, t));
  bridge.on('status', (s) => send(IPC.status, s));
  bridge.on('account', (a) => send(IPC.account, a));
}

// A shipped build must not expose Chromium's remote debugging endpoint (it would hand the renderer and IPC to any local process).
if (app.isPackaged && (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe'))) app.exit(1);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(async () => {
    config = loadConfig();
    if (app.isPackaged) Menu.setApplicationMenu(null); // no default menu: it carries reload / DevTools entries
    // The app needs no browser permissions (camera, mic, geolocation, notifications...): deny every request.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
    hub = new ContextHub(() => config, bridge);
    alerts = new AlertService({
      feed: bridge, db, getConfig: () => config,
      show: electronNotifier(() => { win?.show(); win?.focus(); }),
    });
    orders = new OrderService(bridge, () => config, getDb);
    alerts.start(); // runs in the main process, so alerts keep working with the window hidden
    registerIpc();
    wa = new WhatsAppService({
      store: new SqliteWhatsAppStore(getDb()),
      secrets: { secureStorageAvailable, getToken: getWhatsAppToken, setToken: setWhatsAppToken, clearToken: clearWhatsAppToken },
      getTick: () => bridge.lastTick,
      getFeedStatus: () => bridge.status,
      sendToRenderer: (channel, payload) => { if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false; win.webContents.send(channel, payload); return true; },
      baseUrl: process.env.AURUM_WHATSAPP_BASE_URL || undefined,
      symbolLabel: () => config.symbol,
      getAlerts: () => alerts.listView().map((v) => ({ id: v.alert.id, name: v.alert.name, enabled: v.alert.enabled, summary: v.summary, state: v.status })),
      registerNotificationChannel: (ch) => alerts.registry.register(ch),
      transcriber: makeTranscriber({ getConfig: () => config, getKey }),
      ...(process.env.AURUM_WA_DEBUG ? { log: (m: string) => console.log(`[wa] ${m}`) } : {}),
    });
    registerWhatsAppIpc(ipcMain, wa, async () => wa.sendBriefing(composeBriefing(await briefingInput())));
    wa.start();
    tickStore = new TickStore(getDb);
    tickStore.start();
    tickStore.purge(Date.now() - config.learning.retentionDays * 86_400_000);
    setInterval(() => tickStore?.purge(Date.now() - config.learning.retentionDays * 86_400_000), 6 * 3600_000).unref();
    paper = new PaperService({ getConfig: () => config, store: new SqlitePaperStore(getDb), changed: () => send('paper:changed', null) });
    learning = new LearningService({
      getConfig: () => config, paper: paper!, ticks: tickStore!, kv: { get: (k) => kvGet(k as never), set: (k, v) => kvSet(k as never, v) },
      setDefaults: (sl, tp) => { config = saveConfig({ assistant: { ...config.assistant, defaults: { ...config.assistant.defaults, slPips: sl, tpPips: tp } } }, config); send('config:changed', config); },
      notify: (text) => { send('assist:event', { text, priority: 'normal' }); void wa?.notifyAssistant(text, 'normal'); },
    });
    setInterval(() => learning?.maybeAutoTune(), 30 * 60_000).unref();
    assistant = new AssistantService({
      onPlan: (p) => paper?.syncPlan(p),
      getConfig: () => config, engine: orders.engine, snapshot: () => orders.snapshot(), plans: new SqlitePlanStore(getDb),
      kv: { get: (k) => kvGet(k as never), set: (k, v) => kvSet(k as never, v) },
      notify: (text, priority) => { send('assist:event', { text, priority }); void wa?.notifyAssistant(text, priority); },
      ask: (plan, text) => {
        send('assist:ask', { plan, text });
        void wa?.askTake(plan.id, text).catch(() => false);
      },
      changed: () => send('assist:changed', null),
    });
    orders.approvedPlanIds = () => assistant!.approvedIds();
    wa.setAssistant({
      positionsText: async () => {
        const rows = assistant!.pipsView(await orders.snapshot(), config.pipSize);
        if (!rows.length) return 'No open positions.';
        const f = (v: number | null, signed = false) => (v === null ? '-' : `${signed && v > 0 ? '+' : ''}${v}`);
        return rows.map((r) => `#${r.ticket} ${r.side.toUpperCase()} ${r.lots} lot @ ${r.open}: ${f(r.pips, true)} pips, stop ${r.slPips === null ? 'none' : r.slPips >= 0 ? `locked +${r.slPips}` : `${Math.abs(r.slPips)} pips risk`}, target ${f(r.tpPips)} pips`).join('\n');
      },
      take: (id) => assistant!.take(id), approve: (id, o) => assistant!.approve(id, o),
      proposedSince: (ms) => { const p = assistant!.proposedSince(ms); return p ? { id: p.id, summary: describePlan(p) } : null; },
    });
    bridge.on('tick', (t) => {
      const ts = Date.now();
      if (config.learning.recordTicks) tickStore?.record(ts, t.bid, t.ask);
      paper?.onTick({ ts, bid: t.bid, ask: t.ask });
      void assistant?.onTick({ bid: t.bid, ask: t.ask });
    });
    watcher = new ConnectionWatcher({ notify: (text, priority) => { void wa?.notifyStatus(text, priority); } });
    bridge.on('status', (st: FeedStatus) => watcher?.onStatus(st));
    briefingTimer = setInterval(() => {
      void tickBriefing({
        settings: () => wa.briefing(), lastSent: () => wa.lastBriefing(), markSent: (d) => wa.markBriefing(d),
        send: async () => wa.sendBriefing(composeBriefing(await briefingInput())),
      }).catch(() => undefined);
    }, 30_000);
    setTimeout(() => { void wa?.notifyStatus('Aurum started on your PC. It connects to MT5 by itself when the AurumBridge EA is running.', 'low'); }, 8000);
    createWindow();
    startBackups(join(app.getPath('userData'), 'aurum.db'), join(app.getPath('userData'), 'backups'));
    void initAutoUpdate(); // no-op unless AUTO_UPDATE_ENABLED is flipped (see updater.ts)
    hub.start();
    await startFeed();
  });
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', (e) => {
    // Tell WhatsApp that Aurum is closing (best effort, 3 s at most), then quit for real.
    if (!quitting && wa) {
      e.preventDefault();
      quitting = true;
      watcher?.dispose();
      if (briefingTimer) clearInterval(briefingTimer);
      void wa.notifyStatus('Aurum was closed on your PC. Alerts and the AI stop until you open it again; MT5 positions are not touched.', 'normal', 3000).finally(() => app.quit());
      return;
    }
    hub?.stop();
    tickStore?.stop();
    alerts?.stop();
    void wa?.stop();
    void bridge.stop();
    eaHub?.stop();
    closeDb();
  });
}
