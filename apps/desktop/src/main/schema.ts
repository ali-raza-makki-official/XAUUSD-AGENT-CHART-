/** Every table the app uses. Extend here; schema.test.ts executes this against a real SQLite so a typo cannot ship. */
export const SCHEMA_SQL = `
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
    CREATE TABLE IF NOT EXISTS context_cache (
      workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL, source TEXT NOT NULL,
      fetched_at INTEGER NOT NULL, sig TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, connector_id)
    );
    CREATE TABLE IF NOT EXISTS order_records (
      command_id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (command_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS trade_checks (
      command_id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (command_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS kv (
      workspace_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, key)
    );
    CREATE TABLE IF NOT EXISTS trade_plans (
      id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS order_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL
    );
`;
