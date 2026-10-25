import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';

describe('database schema', () => {
  it('executes cleanly on an empty database and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec(SCHEMA_SQL);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['drawings', 'indicators', 'chats', 'command_log', 'alerts', 'alert_state', 'alert_fires', 'alert_commands', 'notifications', 'context_cache', 'trade_checks', 'kv', 'trade_plans', 'ticks', 'paper_trades']) expect(tables).toContain(t);
  });
  it('every table carries workspace_id (SaaS-ready)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
      if (name === 'ticks') continue; // market data is shared by every workspace
      expect(cols, name).toContain('workspace_id');
    }
  });
});
