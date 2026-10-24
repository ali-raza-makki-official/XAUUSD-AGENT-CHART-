// electron-builder configuration for Aurum (Windows x64 NSIS installer).
// See docs/RELEASING.md. The Python bridge is frozen to resources/bridge/aurum-bridge.exe by PyInstaller
// BEFORE this runs (CI does it; locally: `npm run bridge:exe` from the repo root on Windows).
const path = require('node:path');

// Fuses are security switches burned into the Electron binary. scripts/verify-fuses.mjs and
// electron-builder.config.test.ts assert these exact values, so a regression fails CI.
const electronFuses = {
  runAsNode: false, // ELECTRON_RUN_AS_NODE could turn the app into a generic Node runtime
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false, // NODE_OPTIONS injection
  enableNodeCliInspectArguments: false, // --inspect / SIGUSR1 debugger
  enableEmbeddedAsarIntegrityValidation: true, // refuses a tampered app.asar (Windows, Electron >= 30)
  onlyLoadAppFromAsar: true, // no loose ./app folder override
  // MUST stay true: with it off, Electron cannot load the renderer from app.asar over file:// (ERR_FILE_NOT_FOUND,
  // reproduced on the Linux packaged build). Hardening path: serve the renderer from a custom protocol, then flip it.
  grantFileProtocolExtraPrivileges: true,
};

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'app.aurum.desktop',
  productName: 'Aurum',
  copyright: 'Copyright (c) Aurum',
  directories: { buildResources: 'build', output: 'release' },
  // Only the compiled output goes into app.asar. Runtime deps (electron-updater) are added automatically.
  files: ['out/**', 'package.json'],
  // package.json has a semver range; electron-builder needs the exact installed version.
  electronVersion: require('electron/package.json').version,
  asar: true,
  // The frozen bridge sits OUTSIDE the asar so Windows can execute it.
  // The Linux binary name is only there for the non-Windows --dir smoke build. The Windows build requires the .exe
  // (enforced by the release workflow before packaging).
  extraResources: [{ from: 'resources/bridge', to: 'bridge', filter: ['aurum-bridge.exe', 'aurum-bridge'] }],
  electronFuses,
  // Auto-update feed. The updater code is DISABLED by default (src/main/updater.ts), this only tells
  // electron-builder where releases live and writes resources/app-update.yml.
  publish: [{ provider: 'github', owner: 'ali-raza-makki-official', repo: 'XAUUSD-AGENT-CHART-', releaseType: 'release', updaterCacheDirName: 'aurum-updater' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    artifactName: 'Aurum-Setup-${version}.${ext}',
    // Signing happens only when CSC_LINK / CSC_KEY_PASSWORD are present (see docs/RELEASING.md).
    // Without them electron-builder produces an UNSIGNED installer; Windows SmartScreen will warn.
  },
  nsis: {
    oneClick: false, // show the wizard so the user sees what is installed
    perMachine: false, // per-user install: no admin rights, auto-update friendly
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Aurum',
    uninstallDisplayName: 'Aurum',
    deleteAppDataOnUninstall: false, // never silent; build/installer.nsh asks the user first
    include: 'build/installer.nsh',
    runAfterFinish: true,
  },
  fileAssociations: [],
  // Windows-only installer; the linux --dir smoke build uses this for the unpacked app.
  linux: { executableName: 'aurum', target: ['dir'], category: 'Office', icon: path.join('build', 'icon.png') },
};

module.exports = config;
