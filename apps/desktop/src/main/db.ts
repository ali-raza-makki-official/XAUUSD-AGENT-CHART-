import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';
import { AlertSchema, type Alert, type AlertActor, type FireRecord, type NotificationLogEntry } from '@aurum/core';
import { DrawingSchema, IndicatorSchema, type Drawing, type Indicator } from '@aurum/core';

/** Local SQLite store. workspace_id is on every row now so a later multi-workspace/SaaS move is not a rewrite. */
const WORKSPACE = 'default';
let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(app.getPath('userData'), { recursive: true });
  const handle = new DatabaseSync(join(app.getPath('userData'), 'aurum.db'));
  handle.exec(SCHEMA_SQL);
  db = handle;
  return handle;
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

/** Indicators keep their insertion order (`seq`), because that is also their pane order on the chart. */
export function loadIndicators(symbol: string): { indicators: Indicator[]; commandIds: string[] } {
  const d = open();
  const indicators: Indicator[] = [];
  for (const row of d.prepare('SELECT json FROM indicators WHERE workspace_id = ? AND symbol = ? ORDER BY seq').all(WORKSPACE, symbol)) {
    const parsed = IndicatorSchema.safeParse(JSON.parse(String((row as { json: string }).json)));
    if (parsed.success) indicators.push(parsed.data); // a corrupt row is skipped, not fatal
  }
  const ids = d
    .prepare("SELECT command_id FROM command_log WHERE workspace_id = ? AND symbol = ? AND kind = 'do'")
    .all(WORKSPACE, symbol)
    .map((r) => String((r as { command_id: string }).command_id));
  return { indicators, commandIds: ids };
}

/** One transaction per user/AI action, like drawings. Indicator actions share the command_log table. */
export function persistIndicators(p: PersistPayload): void {
  const d = open();
  const now = Date.now();
  d.exec('BEGIN');
  try {
    for (const c of p.changes) {
      if (c.after === null) {
        d.prepare('DELETE FROM indicators WHERE id = ? AND workspace_id = ?').run(c.id, WORKSPACE);
      } else {
        const ind = IndicatorSchema.parse(c.after);
        const seq = (d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM indicators WHERE workspace_id = ? AND symbol = ?').get(WORKSPACE, p.symbol) as { n: number }).n;
        // On update keep the original seq; on insert (or undo of a delete) append.
        d.prepare(
          'INSERT INTO indicators (id, workspace_id, symbol, seq, json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
        ).run(ind.id, WORKSPACE, p.symbol, seq, JSON.stringify(ind), now);
      }
    }
    const logId = p.log.kind === 'do' ? p.log.commandId : `${p.log.commandId}:${p.log.kind}:${now}`;
    d.prepare(
      'INSERT OR IGNORE INTO command_log (command_id, workspace_id, symbol, actor, kind, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(logId, WORKSPACE, p.symbol, p.log.actor, p.log.kind, `[indicators] ${p.log.label}`, now);
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

/** Last real fetch per market-context connector (news, calendar, sentiment). Shown as stale after a restart, never as fresh. */
export function saveContextCache(connectorId: string, e: { source: string; fetchedAt: number; sig: string; data: unknown }): void {
  open().prepare(
    'INSERT INTO context_cache (workspace_id, connector_id, source, fetched_at, sig, json) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(workspace_id, connector_id) DO UPDATE SET source = excluded.source, fetched_at = excluded.fetched_at, sig = excluded.sig, json = excluded.json',
  ).run(WORKSPACE, connectorId, e.source, e.fetchedAt, e.sig, JSON.stringify(e.data));
}
export function loadContextCache(connectorId: string): { source: string; fetchedAt: number; sig: string; data: unknown } | null {
  const r = open().prepare('SELECT source, fetched_at, sig, json FROM context_cache WHERE workspace_id = ? AND connector_id = ?').get(WORKSPACE, connectorId) as
    | { source: string; fetched_at: number; sig: string; json: string }
    | undefined;
  if (!r) return null;
  try { return { source: String(r.source), fetchedAt: Number(r.fetched_at), sig: String(r.sig), data: JSON.parse(String(r.json)) }; } catch { return null; }
}
export function deleteContextCache(connectorId: string): void {
  open().prepare('DELETE FROM context_cache WHERE workspace_id = ? AND connector_id = ?').run(WORKSPACE, connectorId);
}
