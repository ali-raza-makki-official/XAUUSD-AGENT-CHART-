import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Automatic local backups of aurum.db.
 * - One file per calendar day (aurum-YYYY-MM-DD.db), newest kept, last KEEP files retained.
 * - Made with SQLite `VACUUM INTO`, which writes a consistent, defragmented copy even while the app has the
 *   database open in WAL mode (a plain file copy of aurum.db could miss data sitting in aurum.db-wal).
 * - Restore: quit Aurum, then copy a backup over aurum.db and delete aurum.db-wal / aurum.db-shm. See docs/RELEASING.md.
 */
export const BACKUP_KEEP = 7;
const NAME = /^aurum-(\d{4}-\d{2}-\d{2})\.db$/;

const pad = (n: number) => String(n).padStart(2, '0');
export const backupFileName = (d: Date): string => `aurum-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`;

export interface BackupResult {
  file: string;
  removed: string[];
}

/** Returns null when there is no database yet (fresh install). Throws on a real failure so the caller can log it. */
export function backupDatabase(dbPath: string, backupDir: string, now: Date = new Date(), keep: number = BACKUP_KEEP): BackupResult | null {
  if (!existsSync(dbPath)) return null;
  mkdirSync(backupDir, { recursive: true });
  const target = join(backupDir, backupFileName(now));
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  const src = new DatabaseSync(dbPath);
  try {
    src.exec('PRAGMA busy_timeout = 5000');
    // VACUUM INTO refuses an existing file and takes a quoted path literal; the path is app-controlled, quotes escaped anyway.
    src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  // Verify the copy opens and is intact before it replaces today's earlier backup.
  const check = new DatabaseSync(tmp, { readOnly: true });
  try {
    const row = check.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (row?.integrity_check !== 'ok') throw new Error(`backup integrity check failed: ${row?.integrity_check ?? 'no result'}`);
  } catch (e) {
    check.close();
    rmSync(tmp, { force: true });
    throw e;
  }
  check.close();
  renameSync(tmp, target);
  return { file: target, removed: rotate(backupDir, keep) };
}

/** Deletes all but the newest `keep` backups (names sort chronologically). */
export function rotate(backupDir: string, keep: number): string[] {
  const names = readdirSync(backupDir).filter((n) => NAME.test(n)).sort();
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const n of old) rmSync(join(backupDir, n), { force: true });
  return old;
}

/** Copy a chosen backup over the live database. The app must be closed. Used by the documented restore steps. */
export function restoreBackup(backupFile: string, dbPath: string): void {
  copyFileSync(backupFile, dbPath);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

/** Backup now, then re-check hourly and back up again once the calendar day changes. Returns a stop function. */
export function startBackups(dbPath: string, backupDir: string, log: (msg: string) => void = console.error): () => void {
  let lastDay = '';
  const run = () => {
    const today = backupFileName(new Date());
    if (today === lastDay) return;
    try {
      const r = backupDatabase(dbPath, backupDir);
      if (r) lastDay = today;
    } catch (e) {
      log(`[backup] failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  run();
  const t = setInterval(run, 60 * 60 * 1000);
  t.unref();
  return () => clearInterval(t);
}
