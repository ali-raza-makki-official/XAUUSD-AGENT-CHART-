import { Notification, type IpcMain } from 'electron';
import { z } from 'zod';
import { AlertCommandSchema, type NotificationEvent } from '@aurum/core';
import { IPC } from '../shared';
import type { AlertService } from './alerts';

/** Real OS notification. Throws when the OS cannot show one, so the log records a failed delivery instead of a fake "sent". */
export function electronNotifier(onClick: () => void) {
  return (event: NotificationEvent, opts: { silent: boolean }): void => {
    if (!Notification.isSupported()) throw new Error('This system does not support desktop notifications.');
    const n = new Notification({ title: event.title, body: event.body, silent: opts.silent });
    n.on('click', onClick);
    n.show();
  };
}

/** Zod-validated alert IPC. Every state change goes through AlertStore.dispatch (the one command path). */
export function registerAlertIpc(ipcMain: IpcMain, service: AlertService, send: (channel: string, payload: unknown) => void): void {
  const limit = z.number().int().min(1).max(500).optional();
  ipcMain.handle(IPC.alertsSnapshot, (_e, n: unknown) => service.snapshot(limit.parse(n)));
  ipcMain.handle(IPC.alertsDispatch, (_e, raw: unknown) => {
    const cmd = AlertCommandSchema.parse(raw);
    if (cmd.actor !== 'manual' && cmd.actor !== 'ai') throw new Error('Unsupported actor for this channel.');
    return service.dispatch(cmd);
  });
  ipcMain.handle(IPC.alertsUndo, () => service.undo());
  ipcMain.handle(IPC.alertsRedo, () => service.redo());
  ipcMain.handle(IPC.alertsTestFire, (_e, id: unknown) => service.testFire(z.string().min(1).max(100).parse(id)));
  service.on('changed', (s) => send(IPC.alertsChanged, s));
  service.on('fired', (f) => send(IPC.alertFired, f));
}
