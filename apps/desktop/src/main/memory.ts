import type { DatabaseSync } from 'node:sqlite';
import { MemoryNoteSchema, memoryDigest, searchMemory, stripContext, type ChatLogEntry, type MemoryNote } from '@aurum/core';

const WORKSPACE = 'default';
const MAX_TEXT = 4000;

/**
 * Long-term memory: an append-only archive of every chat turn (app and WhatsApp, all days) plus short notes the user or the AI saved.
 * Everything stays in the local database. Only the digest and recall results are ever sent to the AI provider, and only when memory is on.
 */
export class MemoryService {
  constructor(private readonly db: () => DatabaseSync, private readonly now: () => number = Date.now) {}

  log(e: { channel: 'app' | 'whatsapp'; role: 'user' | 'assistant'; text: string }): void {
    const text = stripContext(e.text).slice(0, MAX_TEXT);
    if (!text) return;
    this.db().prepare('INSERT INTO chat_log (id, workspace_id, ts, channel, role, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, WORKSPACE, this.now(), e.channel, e.role, text);
  }

  archive(days: number, limit = 5000): ChatLogEntry[] {
    const rows = this.db().prepare('SELECT id, ts, channel, role, text FROM chat_log WHERE workspace_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?')
      .all(WORKSPACE, this.now() - days * 86_400_000, limit) as unknown as ChatLogEntry[];
    return rows;
  }

  /** Keyword search over notes and the whole archive. */
  recall(query: string, days: number): { notes: { kind: string; text: string }[]; chats: { when: string; channel: string; role: string; text: string }[] } {
    const notes = searchMemory(query, this.notes().map((n) => ({ ...n, ts: n.createdAt })), 8).map((n) => ({ kind: n.kind, text: n.text }));
    const chats = searchMemory(query, this.archive(days, 20_000), 8).map((c) => ({ when: new Date(c.ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', channel: c.channel, role: c.role, text: c.text.slice(0, 500) }));
    return { notes, chats };
  }

  notes(): MemoryNote[] {
    const rows = this.db().prepare('SELECT json FROM memory_notes WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 500').all(WORKSPACE) as { json: string }[];
    return rows.flatMap((r) => { const p = MemoryNoteSchema.safeParse(JSON.parse(r.json)); return p.success ? [p.data] : []; });
  }

  /** Saves a note; a near-identical existing note is updated instead of duplicated. */
  remember(n: { kind: MemoryNote['kind']; text: string; weight?: number; source: MemoryNote['source'] }): MemoryNote {
    const text = n.text.trim().replace(/\s+/g, ' ');
    const same = this.notes().find((x) => x.text.toLowerCase() === text.toLowerCase());
    const note = MemoryNoteSchema.parse({ id: same?.id ?? `note-${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: n.kind, text, weight: Math.max(same?.weight ?? 0, n.weight ?? 3), source: n.source, createdAt: same?.createdAt ?? this.now() });
    this.db().prepare('INSERT INTO memory_notes (id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id, workspace_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(note.id, WORKSPACE, JSON.stringify(note), this.now());
    return note;
  }

  forget(id: string): void { this.db().prepare('DELETE FROM memory_notes WHERE id = ? AND workspace_id = ?').run(id, WORKSPACE); }

  /** Deletes the notes and the chat archive. Paper trades and ticks are market data, not memory, and stay. */
  clear(): void {
    this.db().prepare('DELETE FROM memory_notes WHERE workspace_id = ?').run(WORKSPACE);
    this.db().prepare('DELETE FROM chat_log WHERE workspace_id = ?').run(WORKSPACE);
  }

  stats(): { turns: number; notes: number; first: number | null } {
    const c = this.db().prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM chat_log WHERE workspace_id = ?').get(WORKSPACE) as { n: number; first: number | null };
    const n = this.db().prepare('SELECT COUNT(*) AS n FROM memory_notes WHERE workspace_id = ?').get(WORKSPACE) as { n: number };
    return { turns: c.n, notes: n.n, first: c.first };
  }

  digest(learning: string | null): string { return memoryDigest(this.notes(), learning); }
}
