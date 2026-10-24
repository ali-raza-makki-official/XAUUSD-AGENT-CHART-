import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from '@aurum/core';

const file = () => join(app.getPath('userData'), 'config.json');

export function loadConfig(): AppConfig {
  try {
    return AppConfigSchema.parse(JSON.parse(readFileSync(file(), 'utf8')));
  } catch {
    return DEFAULT_APP_CONFIG; // first run, or a corrupt file: fall back to safe defaults
  }
}

export function saveConfig(patch: Partial<AppConfig>, current: AppConfig): AppConfig {
  const next = AppConfigSchema.parse({ ...current, ...patch });
  mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file()); // atomic replace so a crash never leaves a half-written config
  return next;
}
