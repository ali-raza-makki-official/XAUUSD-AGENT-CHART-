import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { z } from 'zod';
import { AiPermissionsSchema, AiSettingsSchema, ContextSettingsSchema, DrawingSchema, PROVIDER_IDS, ProviderIdSchema, StyleSchema } from '@aurum/core';
import { TimeframeSchema, type AppConfig } from '@aurum/core';
import { BridgeManager } from './bridge';
import { loadConfig, saveConfig } from './config';
import { closeDb, loadChat, loadDrawings, persist, saveChat } from './db';
import * as llm from './llm';
import { clearConnectorSecret, clearKey, hasKey, secureStorageAvailable, setConnectorSecret, setKey } from './secrets';
import { ContextHub } from './contextHub';
import { IPC } from '../shared';

let config: AppConfig;
const bridge = new BridgeManager();
let hub: ContextHub;
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
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Navigation controls: the app never navigates away or opens windows; external links go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault();
  });
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
        pipSize: z.number().positive(),
        timeframe: TimeframeSchema,
        toolStyles: z.record(z.string(), StyleSchema.partial()),
        magnet: z.boolean(),
        stayInTool: z.boolean(),
        aiPermissions: AiPermissionsSchema,
        ai: AiSettingsSchema,
        context: ContextSettingsSchema,
      })
      .partial()
      .parse(patch);
    const symbolChanged = allowed.brokerSymbol !== undefined && allowed.brokerSymbol !== config.brokerSymbol;
    config = saveConfig(allowed, config);
    if (allowed.context) hub.sync();
    if (symbolChanged) await bridge.start(config.brokerSymbol);
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
  });
  const provider = (v: unknown) => ProviderIdSchema.parse(v);
  ipcMain.handle(IPC.aiStatus, () => ({
    secureStorage: secureStorageAvailable(),
    hasKey: Object.fromEntries(PROVIDER_IDS.map((p) => [p, hasKey(p)])),
  }));
  ipcMain.handle(IPC.aiSetKey, (_e, p: unknown, k: unknown) => setKey(provider(p), z.string().min(8).max(500).parse(k)));
  ipcMain.handle(IPC.aiClearKey, (_e, p: unknown) => clearKey(provider(p)));
  ipcMain.handle(IPC.aiListModels, (_e, p: unknown) => llm.listModels(config, provider(p)));
  ipcMain.handle(IPC.aiTest, (_e, p: unknown) => llm.test(config, provider(p)));
  ipcMain.handle(IPC.aiChat, (_e, id: unknown, req: unknown) => {
    const blocks = z.array(z.object({ type: z.enum(['text', 'tool_call', 'tool_result']) }).passthrough());
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
  ipcMain.handle(IPC.reconnect, () => bridge.start(config.brokerSymbol));
  ipcMain.handle(IPC.snapshot, () => ({ status: bridge.status, tick: bridge.lastTick, account: bridge.account }));
  bridge.on('tick', (t) => send(IPC.tick, t));
  bridge.on('status', (s) => send(IPC.status, s));
  bridge.on('account', (a) => send(IPC.account, a));
}

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
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
    hub = new ContextHub(() => config, bridge);
    registerIpc();
    createWindow();
    hub.start();
    await bridge.start(config.brokerSymbol);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    hub?.stop();
    void bridge.stop();
    closeDb();
  });
}
