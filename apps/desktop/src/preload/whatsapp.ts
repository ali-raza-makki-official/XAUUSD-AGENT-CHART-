import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { WA_IPC, type WhatsAppApi } from '../whatsappShared';

export function whatsAppPreload(ipc: IpcRenderer): WhatsAppApi {
  const on = <T>(channel: string) => (cb: (v: T) => void) => {
    const h = (_e: IpcRendererEvent, v: T) => cb(v);
    ipc.on(channel, h);
    return () => ipc.removeListener(channel, h);
  };
  return {
    waStatus: () => ipc.invoke(WA_IPC.status),
    waSetToken: (t) => ipc.invoke(WA_IPC.setToken, t),
    waClearToken: () => ipc.invoke(WA_IPC.clearToken),
    waStartPairing: () => ipc.invoke(WA_IPC.startPairing),
    waCancelPairing: () => ipc.invoke(WA_IPC.cancelPairing),
    waTest: () => ipc.invoke(WA_IPC.test),
    waGetSettings: () => ipc.invoke(WA_IPC.getSettings),
    waSetSettings: (p) => ipc.invoke(WA_IPC.setSettings, p),
    waHistory: (n) => ipc.invoke(WA_IPC.history, n),
    waUnlink: () => ipc.invoke(WA_IPC.unlink),
    waSetRunning: (on) => ipc.invoke(WA_IPC.setRunning, on),
    onWaStatus: on(WA_IPC.statusPush),
    onWaAiRequest: on(WA_IPC.aiRequest),
    waAiRespond: (r) => ipc.invoke(WA_IPC.aiResponse, r),
    waAiReady: (r) => ipc.invoke(WA_IPC.aiReady, r),
  };
}
