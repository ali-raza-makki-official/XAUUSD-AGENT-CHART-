# Releasing Aurum (Windows installer)

Status honesty: the Windows `.exe`, the PyInstaller + `MetaTrader5` step and the NSIS uninstaller were **not built or run
in the Linux development sandbox**. Everything else (packaging layout, asar contents, fuses, renderer loading from the
packaged layout, frozen-bridge spawn on Linux, backups) was. The first tag build is the real test: see
"First-run risks" below.

## How the pieces fit
- `bridge/` is frozen by PyInstaller into one `aurum-bridge.exe` (`bridge/build_exe.py`, entry `bridge/run_bridge.py`),
  with the `MetaTrader5` package bundled. Users need **no Python and no Node**.
  Why one exe and not "ship Python": smaller, no PATH or bitness surprises, nothing to repair. Trade-off: a `--onefile`
  exe unpacks itself to a temp folder on each start (a second or two) and PyInstaller exes are more often flagged by
  antivirus heuristics. If that becomes a problem, switch `--onefile` to `--onedir` in `build_exe.py`, the
  `extraResources` filter to the folder, and `bridgeCommand()` in `apps/desktop/src/main/bridge.ts` to
  `bridge/aurum-bridge/aurum-bridge.exe`.
- electron-builder (`apps/desktop/electron-builder.config.cjs`) puts the exe in `resources/bridge/` (outside the asar).
  When `app.isPackaged`, `main/bridge.ts` spawns it; in development it still runs `python -m aurum_bridge`.
  The security model is unchanged: loopback only, random port, per-launch token passed by environment, never given to the renderer.
- The MT5 terminal is still required on the user's PC (the bridge attaches to it). The installer does not include MT5.
- The `MetaTrader5` wheel exists only for Windows, so the exe **must be built on Windows** (the release workflow does).

## Cut a release
1. Make sure `main` is green (CI workflow: typecheck, tests, build, Linux pack + fuse check).
2. Bump `version` in `apps/desktop/package.json` (the tag must match it exactly, the workflow checks).
3. Commit, then `git tag v0.1.0 && git push origin v0.1.0`.
4. The **Release** workflow (windows-latest) tests, freezes the bridge, smoke-tests the exe (must answer 401 without a token),
   builds the NSIS installer, verifies the fuses in the packaged `Aurum.exe`, prints the signature status, writes
   `SHA256SUMS.txt`, uploads a workflow artifact and creates a **draft** GitHub Release with
   `Aurum-Setup-<version>.exe`, `.blockmap`, `latest.yml`, `SHA256SUMS.txt`.
5. Download the installer from the draft, install on a clean Windows machine/VM, check the list below, then press **Publish release**.
   Compare `Get-FileHash .\Aurum-Setup-0.1.0.exe` with `SHA256SUMS.txt`.

Smoke checklist on the clean machine: installer runs per-user (no admin prompt), desktop + Start menu shortcuts, app opens,
status shows MT5 not connected or connected (with a demo terminal running), drawings survive restart, uninstall asks
about data.

## Code signing (Authenticode), honestly
Unsigned builds work but Windows SmartScreen shows "Windows protected your PC / Unknown publisher" and some antivirus
tools are more suspicious. A certificate costs money and is bought from a CA; nothing in this repo fakes one.
- OV certificate: removes "unknown publisher" but SmartScreen reputation still builds slowly with downloads.
- EV certificate (hardware token/cloud HSM): immediate SmartScreen reputation. Many providers deliver the key on a USB
  token or only through their cloud signing service, which does not work with a plain `.pfx` secret; if you buy that
  kind, the workflow needs the provider's signing step (tell me which CA and it is a small change).
- Azure Trusted Signing is a cheaper cloud option for eligible organisations/individuals.

If you have an exportable `.pfx`:
1. `[Convert]::ToBase64String([IO.File]::ReadAllBytes("aurum.pfx")) | Set-Clipboard`
2. GitHub repo, Settings, Secrets and variables, Actions, New repository secret:
   - `CSC_LINK` = the base64 text (electron-builder also accepts an https URL or a file path)
   - `CSC_KEY_PASSWORD` = the pfx password
3. Push a tag. The workflow's "Decide on code signing" step turns signing on **only when both secrets exist**; otherwise it
   sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and builds unsigned. "Report signature status" prints the result.
Never commit the pfx or paste the password anywhere else.

## Auto-update (disabled by default)
- Plumbing: `electron-updater` in `apps/desktop/src/main/updater.ts`, feed = GitHub Releases of this repo (`publish` in the
  builder config; the build writes `resources/app-update.yml` and the release contains `latest.yml` + `.blockmap`).
- It is **off**: `AUTO_UPDATE_ENABLED = false`, and it never runs unpackaged. Turning on: publish at least one non-draft
  release, set the constant to `true`, release the next version. Users are asked before anything downloads
  (`autoDownload=false`) and the update installs on the next quit.
- Drafts and pre-releases are ignored by the updater. Updates keep user data (the uninstaller prompt is skipped during updates).
- Unsigned updates install, but with no publisher identity. Sign before enabling this for anyone but yourself.
- The repo must be public for the updater to read releases without a token. If it is private, either make the release assets
  public elsewhere or add a token flow; do not embed a GitHub token in the app.

## Where user data lives (Windows)
`%APPDATA%\Aurum\` (productName is `Aurum`). Contents: `aurum.db` (+ `-wal`/`-shm`: drawings, chat, command log),
`config.json`, `secrets.json` (AI keys, encrypted with Windows DPAPI for that user), `backups\`, Chromium caches.
The installer lives in `%LOCALAPPDATA%\Programs\Aurum`. Uninstall asks whether to delete `%APPDATA%\Aurum`
(default No; silent uninstall keeps it).

## Backups and restore of aurum.db
`main/backup.ts` runs on every app start and then re-checks hourly, writing at most one backup per day to
`%APPDATA%\Aurum\backups\aurum-YYYY-MM-DD.db` (SQLite `VACUUM INTO`, consistent even while the app runs, integrity-checked
before it replaces the day's file) and keeps the newest 7 days. They sit next to the live data, so they protect against
corruption and mistakes, not against deleting the whole folder or a dead disk: copy that folder somewhere else now and then.

Restore: 1) quit Aurum (check Task Manager). 2) In `%APPDATA%\Aurum`, delete `aurum.db-wal` and `aurum.db-shm`.
3) Copy the wanted `backups\aurum-YYYY-MM-DD.db` over `aurum.db`. 4) Start Aurum.
Backups do not contain `secrets.json` or `config.json`.

## Rollback
- Bad release not yet published: delete the draft and the tag (`git push --delete origin v0.1.1`).
- Bad release published: mark it as pre-release or delete it on GitHub (the updater then stops offering it), ship a **higher**
  version with the fix (updates never downgrade; `allowDowngrade=false`). Users who already installed it can install an
  older `Aurum-Setup-x.y.z.exe` over it manually; data in `%APPDATA%\Aurum` is kept, and the restore steps above cover a
  database written by a bad version.

## Security posture of the packaged app
Electron fuses (burned into `Aurum.exe`, config in `electron-builder.config.cjs`, asserted by
`electron-builder.config.test.ts` and `npm run verify:fuses -w @aurum/desktop` in CI and in the release job):
RunAsNode off, NODE_OPTIONS off, `--inspect` off, cookie encryption on, asar integrity validation on, only load from asar.
Known residual: `GrantFileProtocolExtraPrivileges` must stay **on** because the renderer loads from `file://` inside the
asar (turning it off made the packaged app fail with ERR_FILE_NOT_FOUND). Cleaner future step: serve the renderer from a
custom `app://` protocol, then flip it off.
Window: contextIsolation, sandbox, no nodeIntegration, no webview, DevTools disabled when packaged, default menu removed
when packaged, all browser permission requests denied, navigation limited to the app's own files, new windows denied
(https links open in the OS browser), CSP both as a response header and as a build-time `<meta>`, a packaged app that is
launched with `--remote-debugging-port/pipe` exits, single-instance lock.
Fuses mean Playwright/Electron-driven tests cannot attach to the *packaged* binary; test the unpackaged app for that.

## First-run risks on the Windows runner (and how to debug)
1. **PyInstaller misses MetaTrader5/numpy**: symptom is the smoke-test step or the app saying "MetaTrader5 Python package is not
   available". Run the exe with a token on a Windows box and read stderr; add `--hidden-import numpy` or
   `--collect-binaries MetaTrader5`; check the build log for "WARNING: Hidden import".
2. **MetaTrader5 wheel unavailable for the runner's Python** (3.13+ may lag): the workflow pins Python 3.12 x64. Check
   `pip install MetaTrader5` output.
3. **Antivirus quarantines or SmartScreen blocks the exe** (unsigned PyInstaller onefile): test on a clean VM; consider
   `--onedir`, signing, or submitting the file to Microsoft for analysis.
4. **NSIS `installer.nsh` syntax**: validated only by reading (this sandbox has no wine/makensis run). Failure shows in the
   "Build the installer" step as a makensis error with a line number in `apps/desktop/build/installer.nsh`. `${isUpdated}` comes
   from electron-builder's template; if it errors, drop the `${ifNot} ${isUpdated}` wrapper.
5. **Icon/rcedit step**: electron-builder downloads winCodeSign (rcedit) on the runner; transient download failures: re-run the job.
6. **`npm ci` workspace/`sharp` install problems** on Windows: sharp is only used by `npm run icons` (generated icons are
   committed), so it can be moved out of CI if it misbehaves.
7. **Tag/version mismatch** fails the first step by design.
8. **Draft release step**: needs repo setting Actions, General, Workflow permissions to allow write (the job sets
   `contents: write`, but org policy can override).
9. **First launch**: electron-builder asar integrity + fuses on Windows were only verified on the unpacked output cross-built
   in Linux (fuse wire read back, integrity resource updated); actually starting `Aurum.exe` is unverified.
Debug locally on Windows: `pip install MetaTrader5 pyinstaller`, `npm ci`, `npm run bridge:exe`, `npm run dist:win`, output in
`apps/desktop/release/`.

## Regenerating icons
`npm run icons -w @aurum/desktop` renders `design/logo.svg` to `apps/desktop/build/icon.png` (512) and `icon.ico` (16-256).
Generated files are committed.
