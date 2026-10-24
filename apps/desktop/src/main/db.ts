import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DrawingSchema, IndicatorSchema, type Drawing, type Indicator } from '@aurum/core';

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
    CREATE TABLE IF NOT EXISTS indicators (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, symbol TEXT NOT NULL,
      seq INTEGER NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS indicators_ws_symbol ON indicators (workspace_id, symbol);
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS command_log (
      command_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, symbol TEXT NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL
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
