import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('./electron-builder.config.cjs');

// Guards the security fuses and installer defaults against accidental edits. The REAL binary is checked by
// scripts/verify-fuses.mjs in CI after packaging; this test fails earlier, at the config level.
describe('electron-builder config', () => {
  it('keeps every security fuse in its hardened position', () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: true,
    });
  });

  it('is a per-user NSIS x64 installer with shortcuts and no file associations', () => {
    expect(config.appId).toBe('app.aurum.desktop');
    expect(config.productName).toBe('Aurum');
    expect(config.asar).toBe(true);
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.nsis).toMatchObject({ perMachine: false, oneClick: false, createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false });
    expect(config.fileAssociations).toEqual([]);
  });

  it('does not bundle any helper executable (MT5 talks to the app through the EA)', () => {
    expect(config.extraResources ?? []).toEqual([]);
  });
});
