import type { DatabaseSync } from 'node:sqlite';
import {
  ProposedActionSchema, WhatsAppSettingsSchema,
  type PendingConfirmation, type WaHistoryEntry, type WaHistoryStatus, type WaLinkState, type WhatsAppSettings, type WhatsAppStore,
} from '@aurum/core';

/**
 * SQLite persistence for the WhatsApp gateway: poll offset, link state, seen message ids (de-dupe survives restarts),
 * confirmation codes and the command/activity history. No electron import so tests can run it on an in-memory database.
 */
const SEEN_RETENTION_MS = 35 * 24 * 3600 * 1000; // platform keeps updates 30 days; keep ids a little longer

type Row = Record<string, unknown>;

export class SqliteWhatsAppStore implements WhatsAppStore {
  constructor(private readonly db: DatabaseSync, private readonly ws = 'default') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wa_kv (workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (workspace_id, key));
      CREATE TABLE IF NOT EXISTS wa_seen (workspace_id TEXT NOT NULL, message_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, message_id));
      CREATE TABLE IF NOT EXISTS wa_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, at INTEGER NOT NULL, direction TEXT NOT NULL, kind TEXT NOT NULL,
        command_id TEXT, message_id TEXT, summary TEXT NOT NULL, status TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS wa_history_ws_at ON wa_history (workspace_id, at DESC);
      CREATE INDEX IF NOT EXISTS wa_history_msg ON wa_history (workspace_id, message_id);
      CREATE TABLE IF NOT EXISTS wa_pending (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, command_id TEXT NOT NULL, code TEXT NOT NULL, action_json TEXT NOT NULL,
        user_key TEXT NOT NULL, binding TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL, status TEXT NOT NULL
      );
    `);
    db.prepare('DELETE FROM wa_seen WHERE workspace_id = ? AND seen_at < ?').run(ws, Date.now() - SEEN_RETENTION_MS);
  }

  private kvGet(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM wa_kv WHERE workspace_id = ? AND key = ?').get(this.ws, key) as Row | undefined;
    return r ? String(r.value) : null;
  }
  private kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO wa_kv (workspace_id, key, value) VALUES (?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value').run(this.ws, key, value);
  }
  private kvDelete(key: string): void { this.db.prepare('DELETE FROM wa_kv WHERE workspace_id = ? AND key = ?').run(this.ws, key); }

  getOffset(): string | null { return this.kvGet('offset'); }
  setOffset(v: string): void { this.kvSet('offset', v); }
  clearOffset(): void { this.kvDelete('offset'); }

  getLink(): WaLinkState {
    const raw = this.kvGet('link');
    if (!raw) return { status: 'unlinked' };
    try {
      const v = JSON.parse(raw) as WaLinkState;
      if (v.status === 'linked' || v.status === 'pairing') return v;
    } catch { /* fall through */ }
    return { status: 'unlinked' };
  }
  setLink(s: WaLinkState): void { this.kvSet('link', JSON.stringify(s)); }

  getSettings(): WhatsAppSettings {
    try { return WhatsAppSettingsSchema.parse(JSON.parse(this.kvGet('settings') ?? '{}')); } catch { return WhatsAppSettingsSchema.parse({}); }
  }
  setSettings(s: WhatsAppSettings): void { this.kvSet('settings', JSON.stringify(WhatsAppSettingsSchema.parse(s))); }

  markSeen(messageId: string, at: number): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO wa_seen (workspace_id, message_id, seen_at) VALUES (?, ?, ?)').run(this.ws, messageId, at);
    return Number(r.changes) === 1;
  }

  addHistory(e: WaHistoryEntry): number {
    const r = this.db.prepare(
      'INSERT INTO wa_history (workspace_id, at, direction, kind, command_id, message_id, summary, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(this.ws, e.at, e.direction, e.kind, e.commandId, e.messageId, e.summary, e.status, e.detail ?? null);
    return Number(r.lastInsertRowid);
  }
  updateHistory(id: number, patch: Partial<Pick<WaHistoryEntry, 'status' | 'detail' | 'summary' | 'messageId'>>): void {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.detail !== undefined) { sets.push('detail = ?'); vals.push(patch.detail); }
    if (patch.summary !== undefined) { sets.push('summary = ?'); vals.push(patch.summary); }
    if (patch.messageId !== undefined) { sets.push('message_id = ?'); vals.push(patch.messageId); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE wa_history SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals, id, this.ws);
  }
  listHistory(limit: number): WaHistoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM wa_history WHERE workspace_id = ? ORDER BY id DESC LIMIT ?').all(this.ws, Math.min(500, Math.max(1, limit))) as Row[];
    return rows.map((r) => ({
      id: Number(r.id), at: Number(r.at), direction: r.direction as WaHistoryEntry['direction'], kind: String(r.kind),
      commandId: r.command_id === null ? null : String(r.command_id), messageId: r.message_id === null ? null : String(r.message_id),
      summary: String(r.summary), status: r.status as WaHistoryStatus, detail: r.detail === null ? null : String(r.detail),
    }));
  }
  setDelivery(wamid: string, status: 'delivered' | 'read', _at: number): boolean {
    const row = this.db.prepare("SELECT 1 AS x FROM wa_history WHERE workspace_id = ? AND direction = 'out' AND message_id = ?").get(this.ws, wamid);
    if (!row) return false;
    // sent -> delivered -> read, never backwards.
    const allowed = status === 'read' ? "('sent','delivered')" : "('sent')";
    this.db.prepare(`UPDATE wa_history SET status = ? WHERE workspace_id = ? AND direction = 'out' AND message_id = ? AND status IN ${allowed}`).run(status, this.ws, wamid);
    return true;
  }

  getPending(): PendingConfirmation | null {
    const r = this.db.prepare("SELECT * FROM wa_pending WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(this.ws) as Row | undefined;
    if (!r) return null;
    const action = ProposedActionSchema.safeParse(JSON.parse(String(r.action_json)));
    if (!action.success) return null; // a damaged row can never confirm anything
    return {
      id: String(r.id), commandId: String(r.command_id), code: String(r.code), action: action.data, userKey: String(r.user_key), binding: String(r.binding),
      createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), attempts: Number(r.attempts), status: r.status as PendingConfirmation['status'],
    };
  }
  savePending(p: PendingConfirmation): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE wa_pending SET status = 'superseded' WHERE workspace_id = ? AND status = 'pending'").run(this.ws);
      this.db.prepare(
        'INSERT OR REPLACE INTO wa_pending (id, workspace_id, command_id, code, action_json, user_key, binding, created_at, expires_at, attempts, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(p.id, this.ws, p.commandId, p.code, JSON.stringify(p.action), p.userKey, p.binding, p.createdAt, p.expiresAt, p.attempts, p.status);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  updatePending(id: string, patch: Partial<Pick<PendingConfirmation, 'attempts' | 'status'>>): void {
    if (patch.attempts !== undefined) this.db.prepare('UPDATE wa_pending SET attempts = ? WHERE id = ? AND workspace_id = ?').run(patch.attempts, id, this.ws);
    if (patch.status !== undefined) this.db.prepare('UPDATE wa_pending SET status = ? WHERE id = ? AND workspace_id = ?').run(patch.status, id, this.ws);
  }
  consumePending(id: string, now: number): boolean {
    const r = this.db.prepare("UPDATE wa_pending SET status = 'used' WHERE id = ? AND workspace_id = ? AND status = 'pending' AND expires_at > ?").run(id, this.ws, now);
    return Number(r.changes) === 1;
  }

  getMeta(key: string): string | null { return this.kvGet(`meta:${key}`); }
  setMeta(key: string, value: string): void { this.kvSet(`meta:${key}`, value); }

  /** Unlink: forget the link and any pending code; keep history and seen ids. */
  resetLink(): void {
    this.setLink({ status: 'unlinked' });
    this.db.prepare("UPDATE wa_pending SET status = 'cancelled' WHERE workspace_id = ? AND status = 'pending'").run(this.ws);
  }
}
