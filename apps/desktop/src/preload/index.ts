import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AurumApi } from '../shared';
import { whatsAppPreload } from './whatsapp';

const on =
  <T>(channel: string) =>
  (cb: (v: T) => void) => {
    const h = (_e: IpcRendererEvent, v: T) => cb(v);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  };

const api: AurumApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (patch) => ipcRenderer.invoke(IPC.setConfig, patch),
  candles: (tf, count) => ipcRenderer.invoke(IPC.candles, tf, count),
  findSymbols: (q) => ipcRenderer.invoke(IPC.findSymbols, q),
  reconnect: () => ipcRenderer.invoke(IPC.reconnect),
  symbolSpec: () => ipcRenderer.invoke(IPC.symbolSpec),
  loadDrawings: (symbol) => ipcRenderer.invoke(IPC.loadDrawings, symbol),
  persistDrawings: (p) => ipcRenderer.invoke(IPC.persistDrawings, p),
  loadIndicators: (symbol) => ipcRenderer.invoke(IPC.loadIndicators, symbol),
  persistIndicators: (p) => ipcRenderer.invoke(IPC.persistIndicators, p),
  snapshot: () => ipcRenderer.invoke(IPC.snapshot),
  aiStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  aiSetKey: (p, k) => ipcRenderer.invoke(IPC.aiSetKey, p, k),
  aiClearKey: (p) => ipcRenderer.invoke(IPC.aiClearKey, p),
  aiListModels: (p) => ipcRenderer.invoke(IPC.aiListModels, p),
  aiTest: (p) => ipcRenderer.invoke(IPC.aiTest, p),
  aiChat: (id, req) => ipcRenderer.invoke(IPC.aiChat, id, req),
  aiAbort: (id) => ipcRenderer.invoke(IPC.aiAbort, id),
  contextSnapshot: (force) => ipcRenderer.invoke(IPC.contextSnapshot, force),
  contextRead: (kind, force) => ipcRenderer.invoke(IPC.contextRead, kind, force),
  contextStatus: () => ipcRenderer.invoke(IPC.contextStatus),
  contextTest: (id) => ipcRenderer.invoke(IPC.contextTest, id),
  contextRefresh: () => ipcRenderer.invoke(IPC.contextRefresh),
  contextSetSecret: (id, v) => ipcRenderer.invoke(IPC.contextSetSecret, id, v),
  contextClearSecret: (id) => ipcRenderer.invoke(IPC.contextClearSecret, id),
  loadChat: () => ipcRenderer.invoke(IPC.loadChat),
  saveChat: (j) => ipcRenderer.invoke(IPC.saveChat, j),
  onTick: on(IPC.tick),
  onStatus: on(IPC.status),
  onAccount: on(IPC.account),
  ...whatsAppPreload(ipcRenderer),
};

contextBridge.exposeInMainWorld('aurum', api);
