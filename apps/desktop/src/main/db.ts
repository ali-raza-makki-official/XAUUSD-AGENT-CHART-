import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AlertSchema, type Alert, type AlertActor, type FireRecord, type NotificationLogEntry } from '@aurum/core';
import { DrawingSchema, type Drawing } from '@aurum/core';

/** Local SQLite store. workspace_id is on every row now so a later multi-workspace/SaaS move is not a rewrite. */
const WORKSPACE = 'default';
let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(app.getPath('userData'), { recursive: true });
  db = new DatabaseSync(join(app.getPath('userData'), 'aurum.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS drawings (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, symbol TEXT NOT NULL,
      json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drawings_ws_symbol ON drawings (workspace_id, symbol);
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS command_log (
      command_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, symbol TEXT NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS alert_state (
      alert_id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (alert_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS alert_fires (
      id TEXT NOT NULL, workspace_id TEXT NOT NULL, alert_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS alert_commands (
      command_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (command_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT NOT NULL, workspace_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (id, workspace_id)
    );
  `);
  return db;
}

export function loadDrawings(symbol: string): { drawings: Drawing[]; commandIds: string[] } {
  const d = open();
  const drawings: Drawing[] = [];
  for (const row of d.prepare('SELECT json FROM drawings WHERE workspace_id = ? AND symbol = ?').all(WORKSPACE, symbol)) {
    const parsed = DrawingSchema.safeParse(JSON.parse(String((row as { json: string }).json)));
    if (parsed.success) drawings.push(parsed.data); // a corrupt row is skipped, not fatal
  }
  const ids = d
    .prepare("SELECT command_id FROM command_log WHERE workspace_id = ? AND symbol = ? AND kind = 'do'")
    .all(WORKSPACE, symbol)
    .map((r) => String((r as { command_id: string }).command_id));
  return { drawings, commandIds: ids };
}

export interface PersistPayload {
  symbol: string;
  log: { commandId: string; actor: 'manual' | 'ai'; kind: 'do' | 'undo' | 'redo'; label: string };
  changes: { id: string; after: unknown | null }[];
}

/** One transaction per user/AI action, so a batch is saved whole or not at all. */
export function persist(p: PersistPayload): void {
  const d = open();
  const now = Date.now();
  d.exec('BEGIN');
  try {
    for (const c of p.changes) {
      if (c.after === null) {
        d.prepare('DELETE FROM drawings WHERE id = ? AND workspace_id = ?').run(c.id, WORKSPACE);
      } else {
        const drawing = DrawingSchema.parse(c.after);
        d.prepare(
          'INSERT INTO drawings (id, workspace_id, symbol, json, updated_at) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
        ).run(drawing.id, WORKSPACE, p.symbol, JSON.stringify(drawing), now);
      }
    }
    const logId = p.log.kind === 'do' ? p.log.commandId : `${p.log.commandId}:${p.log.kind}:${now}`;
    d.prepare(
      'INSERT OR IGNORE INTO command_log (command_id, workspace_id, symbol, actor, kind, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(logId, WORKSPACE, p.symbol, p.log.actor, p.log.kind, p.log.label, now);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

const CHAT_ID = 'default';
export function loadChat(): string | null {
  const row = open().prepare('SELECT json FROM chats WHERE id = ? AND workspace_id = ?').get(CHAT_ID, WORKSPACE) as { json: string } | undefined;
  return row ? String(row.json) : null;
}
export function saveChat(json: string): void {
  open().prepare('INSERT INTO chats (id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id, workspace_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(CHAT_ID, WORKSPACE, json, Date.now());
}

// ---------- alerts, fire history and the in-app notification log ----------

export interface AlertDbData {
  alerts: Alert[];
  states: Record<string, unknown>;
  fires: FireRecord[];
  notifications: NotificationLogEntry[];
  commandIds: string[];
}

const parseRows = <T>(rows: unknown[]): T[] => {
  const out: T[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(String((r as { json: string }).json)) as T); } catch { /* a corrupt row is skipped, not fatal */ }
  }
  return out;
};

export function loadAlertData(): AlertDbData {
  const d = open();
  const alerts: Alert[] = [];
  for (const a of parseRows<unknown>(d.prepare('SELECT json FROM alerts WHERE workspace_id = ?').all(WORKSPACE))) {
    const p = AlertSchema.safeParse(a);
    if (p.success) alerts.push(p.data);
  }
  const states: Record<string, unknown> = {};
  for (const r of d.prepare('SELECT alert_id, json FROM alert_state WHERE workspace_id = ?').all(WORKSPACE) as { alert_id: string; json: string }[]) {
    try { states[String(r.alert_id)] = JSON.parse(String(r.json)); } catch { /* skip */ }
  }
  return {
    alerts, states,
    fires: parseRows<FireRecord>(d.prepare('SELECT json FROM alert_fires WHERE workspace_id = ? ORDER BY at DESC LIMIT 300').all(WORKSPACE)).reverse(),
    notifications: parseRows<NotificationLogEntry>(d.prepare('SELECT json FROM notifications WHERE workspace_id = ? ORDER BY at DESC LIMIT 500').all(WORKSPACE)).reverse(),
    commandIds: d.prepare("SELECT command_id FROM alert_commands WHERE workspace_id = ? AND kind = 'do'").all(WORKSPACE).map((r) => String((r as { command_id: string }).command_id)),
  };
}

export interface AlertPersist {
  log: { commandId: string; actor: AlertActor; kind: 'do' | 'undo' | 'redo'; label: string };
  changes: { id: string; after: Alert | null }[];
}

/** One transaction per alert command, so a batch is saved whole or not at all. */
export function persistAlertChange(p: AlertPersist): void {
  const d = open();
  const now = Date.now();
  d.exec('BEGIN');
  try {
    for (const c of p.changes) {
      if (c.after === null) d.prepare('DELETE FROM alerts WHERE id = ? AND workspace_id = ?').run(c.id, WORKSPACE);
      else {
        d.prepare('INSERT INTO alerts (id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id, workspace_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
          .run(c.id, WORKSPACE, JSON.stringify(AlertSchema.parse(c.after)), now);
      }
    }
    const logId = p.log.kind === 'do' ? p.log.commandId : `${p.log.commandId}:${p.log.kind}:${now}`;
    d.prepare('INSERT OR IGNORE INTO alert_commands (command_id, workspace_id, actor, kind, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(logId, WORKSPACE, p.log.actor, p.log.kind, p.log.label, now);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function saveAlertState(alertId: string, state: unknown): void {
  open().prepare('INSERT INTO alert_state (alert_id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(alert_id, workspace_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run(alertId, WORKSPACE, JSON.stringify(state), Date.now());
}

export function saveAlertFire(f: FireRecord): void {
  const d = open();
  d.prepare('INSERT OR REPLACE INTO alert_fires (id, workspace_id, alert_id, at, json) VALUES (?, ?, ?, ?, ?)').run(f.id, WORKSPACE, f.alertId, f.at, JSON.stringify(f));
  d.prepare('DELETE FROM alert_fires WHERE workspace_id = ? AND id NOT IN (SELECT id FROM alert_fires WHERE workspace_id = ? ORDER BY at DESC LIMIT 1000)').run(WORKSPACE, WORKSPACE);
}

export function saveNotification(e: NotificationLogEntry): void {
  const d = open();
  d.prepare('INSERT OR REPLACE INTO notifications (id, workspace_id, at, json) VALUES (?, ?, ?, ?)').run(e.event.id, WORKSPACE, e.event.at, JSON.stringify(e));
  d.prepare('DELETE FROM notifications WHERE workspace_id = ? AND id NOT IN (SELECT id FROM notifications WHERE workspace_id = ? ORDER BY at DESC LIMIT 500)').run(WORKSPACE, WORKSPACE);
}
