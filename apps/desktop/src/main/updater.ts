import { app, dialog } from 'electron';

/**
 * Auto-update plumbing (electron-updater against GitHub Releases, see `publish` in electron-builder.config.cjs).
 *
 * DISABLED BY DEFAULT. Flip AUTO_UPDATE_ENABLED to true only after:
 *  1. at least one non-draft GitHub Release exists with the installer, `latest.yml` and the `.blockmap`, and
 *  2. you have decided on signing (docs/RELEASING.md). Unsigned updates still work technically, but Windows
 *     gives no publisher identity and updates carry the same SmartScreen friction as the first install.
 * It never runs in development (unpackaged) builds. Nothing downloads without the user's say-so.
 */
export const AUTO_UPDATE_ENABLED = false;

export async function initAutoUpdate(enabled: boolean = AUTO_UPDATE_ENABLED): Promise<void> {
  if (!enabled || !app.isPackaged) return;
  try {
    const { autoUpdater } = await import('electron-updater'); // loaded lazily so a disabled build never touches it
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('error', (e) => console.error('[updater]', e.message));
    autoUpdater.on('update-available', (info) => {
      void dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Download', 'Later'],
          defaultId: 1,
          cancelId: 1,
          title: 'Aurum update',
          message: `Aurum ${info.version} is available.`,
          detail: 'Download it now? It installs when you next close Aurum. Your data and settings are kept.',
        })
        .then((r) => {
          if (r.response === 0) void autoUpdater.downloadUpdate();
        });
    });
    await autoUpdater.checkForUpdates();
  } catch (e) {
    console.error('[updater] check failed:', e instanceof Error ? e.message : e);
  }
}
