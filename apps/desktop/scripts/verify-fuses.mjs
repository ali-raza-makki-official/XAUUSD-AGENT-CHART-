// Reads the fuse wire from a PACKAGED Electron binary and fails if any security fuse regressed.
// Usage: node scripts/verify-fuses.mjs <path-to-Aurum.exe | linux unpacked binary>
//   default path: the electron-builder output for the current platform under release/.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const require = createRequire(import.meta.url);
const { electronFuses } = require('../electron-builder.config.cjs');
const here = dirname(fileURLToPath(import.meta.url));

function defaultBinary() {
  const rel = join(here, '..', 'release');
  const candidates = [join(rel, 'win-unpacked', 'Aurum.exe'), join(rel, 'linux-unpacked', 'aurum')];
  return candidates.find(existsSync) ?? candidates[0];
}

// electron-builder option name -> @electron/fuses enum key
const MAP = {
  runAsNode: 'RunAsNode',
  enableCookieEncryption: 'EnableCookieEncryption',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
  grantFileProtocolExtraPrivileges: 'GrantFileProtocolExtraPrivileges',
};

const binary = process.argv[2] ?? defaultBinary();
if (!existsSync(binary)) {
  console.error(`binary not found: ${binary}`);
  process.exit(2);
}
const wire = await getCurrentFuseWire(binary);
let bad = 0;
for (const [opt, want] of Object.entries(electronFuses)) {
  const key = FuseV1Options[MAP[opt]];
  const got = wire[key];
  const expected = want ? FuseState.ENABLE : FuseState.DISABLE;
  const ok = got === expected;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${MAP[opt]} want=${want ? 'ENABLE' : 'DISABLE'} got=${got === FuseState.ENABLE ? 'ENABLE' : got === FuseState.DISABLE ? 'DISABLE' : got}`);
}
if (bad) {
  console.error(`${bad} fuse(s) differ from electron-builder.config.cjs in ${binary}`);
  process.exit(1);
}
console.log(`all fuses verified in ${binary}`);
