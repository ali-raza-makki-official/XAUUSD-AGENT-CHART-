import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { NotificationSettingsSchema, AiPermissionsSchema, AiSettingsSchema, ChartLayoutSchema, ContextSettingsSchema, RiskSettingsSchema, DrawingSchema, IndicatorSchema, PROVIDER_IDS, PaneTimeframesSchema, ProviderIdSchema, StyleSchema } from '@aurum/core';
import { TimeframeSchema, type AppConfig, type FeedStatus } from '@aurum/core';
import { startBackups } from './backup';
import { BridgeManager } from './bridge';
import { loadConfig, saveConfig } from './config';
import { makeTranscriber, voiceRoute } from './transcribe';
import { ConnectionWatcher } from './connectionWatch';
import { closeDb, loadChat, loadDrawings, loadIndicators, persist, persistIndicators, saveChat } from './db';
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
    });
    registerWhatsAppIpc(ipcMain, wa);
    wa.start();
    watcher = new ConnectionWatcher({ notify: (text, priority) => { void wa?.notifyStatus(text, priority); } });
    bridge.on('status', (st: FeedStatus) => watcher?.onStatus(st));
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
      void wa.notifyStatus('Aurum was closed on your PC. Alerts and the AI stop until you open it again; MT5 positions are not touched.', 'normal', 3000).finally(() => app.quit());
      return;
    }
    hub?.stop();
    alerts?.stop();
    void wa?.stop();
    void bridge.stop();
    eaHub?.stop();
    closeDb();
  });
}
