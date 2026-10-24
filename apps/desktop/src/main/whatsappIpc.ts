import type { IpcMain } from 'electron';
import { z } from 'zod';
import { WA_IPC, type WaAiResponse } from '../whatsappShared';
import { WaUiSettingsPatchSchema, type WhatsAppService } from './whatsappService';

const AiResponseSchema = z.object({
  id: z.string().min(1).max(100),
  ok: z.boolean(),
  text: z.string().max(100_000),
  error: z.string().max(2000).optional(),
  proposed: z.object({
    calls: z.array(z.object({ name: z.string().min(1).max(64), input: z.unknown() })).min(1).max(20),
    preview: z.string().min(1).max(4000),
  }).optional(),
});

/** Zod-validated WhatsApp IPC. The token only ever flows renderer -> main here; nothing returns it. */
export function registerWhatsAppIpc(ipc: IpcMain, svc: WhatsAppService): void {
  ipc.handle(WA_IPC.status, () => svc.status());
  ipc.handle(WA_IPC.setToken, (_e, t: unknown) => svc.setToken(z.string().trim().min(8).max(2000).parse(t)));
  ipc.handle(WA_IPC.clearToken, () => svc.clearToken());
  ipc.handle(WA_IPC.startPairing, () => svc.startPairing());
  ipc.handle(WA_IPC.cancelPairing, () => svc.cancelPairing());
  ipc.handle(WA_IPC.test, () => svc.test());
  ipc.handle(WA_IPC.getSettings, () => svc.uiSettings());
  ipc.handle(WA_IPC.setSettings, (_e, p: unknown) => svc.setUiSettings(WaUiSettingsPatchSchema.parse(p)));
  ipc.handle(WA_IPC.history, (_e, n: unknown) => svc.history(z.number().int().min(1).max(500).default(100).parse(n ?? undefined)));
  ipc.handle(WA_IPC.unlink, () => svc.unlink());
  ipc.handle(WA_IPC.setRunning, (_e, on: unknown) => svc.setRunning(z.boolean().parse(on)));
  ipc.handle(WA_IPC.aiResponse, (_e, r: unknown) => svc.handleRendererResponse(AiResponseSchema.parse(r) as WaAiResponse));
  ipc.handle(WA_IPC.aiReady, (_e, r: unknown) => svc.setAiReady(z.boolean().parse(r)));
}
