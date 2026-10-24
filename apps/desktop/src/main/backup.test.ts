import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, backupFileName, restoreBackup, BACKUP_KEEP } from './backup';

let dir: string;
let dbPath: string;
let backups: string;

function seed(rows: number): void {
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (n INTEGER)');
  for (let i = 0; i < rows; i++) d.exec(`INSERT INTO t VALUES (${i})`);
  d.close();
}
const count = (p: string) => {
  const d = new DatabaseSync(p, { readOnly: true });
  const n = (d.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
  d.close();
  return n;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aurum-backup-'));
  dbPath = join(dir, 'aurum.db');
  backups = join(dir, 'backups');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backupDatabase', () => {
  it('does nothing when no database exists yet', () => {
    expect(backupDatabase(dbPath, backups)).toBeNull();
    expect(existsSync(backups)).toBe(false);
  });

  it('writes a consistent copy even while the source is open in WAL mode', () => {
    seed(5);
    const live = new DatabaseSync(dbPath); // keeps aurum.db-wal in play
    live.exec('INSERT INTO t VALUES (99)');
    const r = backupDatabase(dbPath, backups, new Date(2026, 0, 10));
    live.close();
    expect(r?.file.endsWith('aurum-2026-01-10.db')).toBe(true);
    expect(count(r!.file)).toBe(6);
  });

  it('keeps one file per day (same day overwrites) and rotates to the newest 7', () => {
    seed(1);
    for (let day = 1; day <= 10; day++) backupDatabase(dbPath, backups, new Date(2026, 0, day));
    backupDatabase(dbPath, backups, new Date(2026, 0, 10)); // same day again
    const files = readdirSync(backups).sort();
    expect(files).toHaveLength(BACKUP_KEEP);
    expect(files[0]).toBe(backupFileName(new Date(2026, 0, 4)));
    expect(files.at(-1)).toBe(backupFileName(new Date(2026, 0, 10)));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('ignores unrelated files in the backup folder when rotating', () => {
    seed(1);
    backupDatabase(dbPath, backups, new Date(2026, 0, 1));
    writeFileSync(join(backups, 'notes.txt'), 'keep me');
    for (let day = 2; day <= 12; day++) backupDatabase(dbPath, backups, new Date(2026, 0, day));
    expect(readdirSync(backups)).toContain('notes.txt');
  });

  it('restore replaces the live database with the backup', () => {
    seed(3);
    const r = backupDatabase(dbPath, backups, new Date(2026, 0, 1))!;
    const d = new DatabaseSync(dbPath);
    d.exec('DELETE FROM t');
    d.close();
    expect(count(dbPath)).toBe(0);
    restoreBackup(r.file, dbPath);
    expect(count(dbPath)).toBe(3);
  });
});
