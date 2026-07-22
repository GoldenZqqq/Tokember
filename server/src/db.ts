import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { runSchemaMigrations } from './migrations.js'
import { registerUsageMetricFunctions } from './usage-metrics.js'

const ACTIVITY_ONLY_MIGRATION = '2026-07-16-activity-only-remove-sub2api'
const HERMES_DEVICE_MIGRATION = '2026-07-16-rehome-hermes-from-sub2api-device'

function ensureAppMigrationsTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function applyActivityOnlyMigration(db: DatabaseType): void {
  ensureAppMigrationsTable(db)
  const applied = db.prepare('SELECT 1 FROM app_migrations WHERE name = ?')
    .get(ACTIVITY_ONLY_MIGRATION)
  if (applied) return

  db.transaction(() => {
    db.prepare("DELETE FROM usage_records WHERE lower(provider) = 'sub2api'").run()
    db.prepare(`
      DELETE FROM devices
      WHERE NOT EXISTS (
        SELECT 1 FROM usage_records WHERE usage_records.device_id = devices.id
      ) AND (
        lower(id) = 'sub2api'
        OR lower(id) LIKE 'sub2api-key-%'
        OR lower(name) = 'sub2api'
        OR lower(name) LIKE 'sub2api-%'
      )
    `).run()
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)')
      .run(ACTIVITY_ONLY_MIGRATION)
  })()
}

function applyHermesDeviceMigration(db: DatabaseType): void {
  const applied = db.prepare('SELECT 1 FROM app_migrations WHERE name = ?')
    .get(HERMES_DEVICE_MIGRATION)
  if (applied) return

  const gatewayDevices = `
    lower(id) = 'sub2api'
    OR lower(id) LIKE 'sub2api-key-%'
    OR lower(name) = 'sub2api'
    OR lower(name) LIKE 'sub2api-%'
  `
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO devices (id, name)
      SELECT 'hermes-27', 'HERMES-27'
      WHERE EXISTS (
        SELECT 1 FROM usage_records
        WHERE lower(provider) = 'hermes'
          AND lower(coalesce(source_file, '')) LIKE 'hermes%'
          AND device_id IN (SELECT id FROM devices WHERE ${gatewayDevices})
      );
      UPDATE usage_records SET device_id = 'hermes-27'
      WHERE lower(provider) = 'hermes'
        AND lower(coalesce(source_file, '')) LIKE 'hermes%'
        AND device_id IN (SELECT id FROM devices WHERE ${gatewayDevices});
      DELETE FROM usage_records
      WHERE device_id IN (SELECT id FROM devices WHERE ${gatewayDevices});
      DELETE FROM source_cutover_events
      WHERE device_id IN (SELECT id FROM devices WHERE ${gatewayDevices});
      DELETE FROM source_cutovers
      WHERE device_id IN (SELECT id FROM devices WHERE ${gatewayDevices});
      DELETE FROM devices WHERE ${gatewayDevices};
    `)
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)')
      .run(HERMES_DEVICE_MIGRATION)
  })()
}

export function resolveDbPath(dbPath?: string, cwd = process.cwd()): string {
  if (dbPath) {
    if (basename(dbPath) !== 'tokember.db' || existsSync(dbPath)) return dbPath
    const legacySibling = join(dirname(dbPath), 'ai-burn.db')
    return existsSync(legacySibling) ? legacySibling : dbPath
  }
  const canonical = join(cwd, 'tokember.db')
  const legacy = join(cwd, 'ai-burn.db')
  return existsSync(canonical) || !existsSync(legacy) ? canonical : legacy
}

export function initDB(dbPath?: string): DatabaseType {
  const path = resolveDbPath(dbPath)
  const db = new Database(path)
  registerUsageMetricFunctions(db)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      source_file TEXT,
      dedup_key TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_device ON usage_records(device_id);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_records(provider);
    CREATE INDEX IF NOT EXISTS idx_usage_source_authority
      ON usage_records(device_id, provider, source_file, timestamp);

    CREATE TABLE IF NOT EXISTS source_cutovers (
      device_id TEXT NOT NULL REFERENCES devices(id),
      provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
      cutover_at TEXT NOT NULL,
      legacy_source TEXT NOT NULL,
      native_source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device_id, provider)
    );

    CREATE TABLE IF NOT EXISTS source_cutover_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id),
      provider TEXT NOT NULL,
      previous_cutover_at TEXT,
      cutover_at TEXT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_source_cutover_events_device
      ON source_cutover_events(device_id, provider, created_at);

  `)

  runSchemaMigrations(db)
  applyActivityOnlyMigration(db)
  applyHermesDeviceMigration(db)

  return db
}

export type DB = DatabaseType
