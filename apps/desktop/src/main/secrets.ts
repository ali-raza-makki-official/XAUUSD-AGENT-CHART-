import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '@aurum/core';

/**
 * API keys live only in the main process, encrypted with the OS credential store (DPAPI on Windows).
 * They are never sent to the renderer, never put in config.json and never logged.
 * Developers/CI can instead supply AURUM_KEY_<PROVIDER> in the environment (not stored).
 */
const file = () => join(app.getPath('userData'), 'secrets.json');

function read(): Record<string, string> {
  try { return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>; } catch { return {}; }
}
function write(data: Record<string, string>): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file());
}

export const secureStorageAvailable = (): boolean => safeStorage.isEncryptionAvailable();
const envName = (p: ProviderId) => `AURUM_KEY_${p.toUpperCase()}`;

export function setKey(provider: ProviderId, key: string): void {
  if (!secureStorageAvailable()) throw new Error('Secure key storage is not available on this system, so the key was not saved.');
  write({ ...read(), [provider]: safeStorage.encryptString(key.trim()).toString('base64') });
}
export function clearKey(provider: ProviderId): void {
  const d = read();
  delete d[provider];
  write(d);
}
export function getKey(provider: ProviderId): string | null {
  const fromEnv = process.env[envName(provider)];
  if (fromEnv) return fromEnv;
  const enc = read()[provider];
  if (!enc || !secureStorageAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
export const hasKey = (provider: ProviderId): boolean => getKey(provider) !== null;

// --- WhatsApp agent API token (own entry in the same encrypted file; provider keys untouched) ---
const WA_KEY = 'whatsapp';
export function setWhatsAppToken(token: string): void {
  if (!secureStorageAvailable()) throw new Error('Secure key storage is not available on this system, so the token was not saved.');
  write({ ...read(), [WA_KEY]: safeStorage.encryptString(token.trim()).toString('base64') });
}
export function clearWhatsAppToken(): void {
  const d = read();
  delete d[WA_KEY];
  write(d);
}
export function getWhatsAppToken(): string | null {
  if (process.env.AURUM_WHATSAPP_TOKEN) return process.env.AURUM_WHATSAPP_TOKEN;
  const enc = read()[WA_KEY];
  if (!enc || !secureStorageAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
export const hasWhatsAppToken = (): boolean => getWhatsAppToken() !== null;
