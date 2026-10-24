import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { z } from 'zod';
import { TimeframeSchema, type AppConfig } from '@aurum/core';
import { BridgeManager } from './bridge';
import { loadConfig, saveConfig } from './config';
import { IPC } from '../shared';

let config: AppConfig;
const bridge = new BridgeManager();
let win: BrowserWindow | null = null;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
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
      .object({ brokerSymbol: z.string().min(1).max(32), pipSize: z.number().positive(), timeframe: TimeframeSchema })
      .partial()
      .parse(patch);
    const symbolChanged = allowed.brokerSymbol !== undefined && allowed.brokerSymbol !== config.brokerSymbol;
    config = saveConfig(allowed, config);
    if (symbolChanged) await bridge.start(config.brokerSymbol);
    return config;
  });
  ipcMain.handle(IPC.candles, (_e, tf: unknown, count: unknown) =>
    bridge.candles(TimeframeSchema.parse(tf), z.number().int().min(1).max(5000).parse(count)),
  );
  ipcMain.handle(IPC.findSymbols, (_e, q: unknown) => bridge.findSymbols(z.string().max(64).parse(q)));
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
    registerIpc();
    createWindow();
    await bridge.start(config.brokerSymbol);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => void bridge.stop());
}
