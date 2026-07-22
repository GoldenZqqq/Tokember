import assert from 'node:assert/strict'
import test from 'node:test'
import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { initDB } from './db.js'
import {
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
  runSchemaMigrations,
  type SchemaMigration,
} from './migrations.js'

function tableExists(db: DatabaseType, name: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) != null
}

function createLegacyUsageDatabase(): DatabaseType {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO devices (id, name) VALUES ('legacy', 'Legacy');
    INSERT INTO usage_records
      (device_id, provider, model, timestamp, dedup_key)
    VALUES
      ('legacy', 'codex', 'gpt', '2025-01-01T00:00:00.000Z', 'codex-old'),
      ('legacy', 'hermes', 'mimo', '2025-01-01T00:00:00.000Z', 'hermes-old');
  `)
  return db
}

test('fresh schema reaches the latest version idempotently', () => {
  const db = initDB(':memory:')
  assert.equal(getSchemaVersion(db), LATEST_SCHEMA_VERSION)
  assert.deepEqual(db.prepare('PRAGMA table_info(devices)').all()
    .map((column: unknown) => (column as { name: string }).name)
    .filter(name => ['platform', 'architecture', 'hostname'].includes(name)), [
      'platform', 'architecture', 'hostname',
    ])
  const before = (db.prepare('SELECT COUNT(*) AS count FROM schema_migrations')
    .get() as { count: number }).count

  runSchemaMigrations(db)

  assert.equal(getSchemaVersion(db), LATEST_SCHEMA_VERSION)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations')
    .get() as { count: number }).count, before)
  db.close()
})

test('collector observability migration creates constrained run tables', () => {
  const db = initDB(':memory:')
  assert.equal(tableExists(db, 'collector_runs'), true)
  assert.equal(tableExists(db, 'collector_source_runs'), true)
  assert.equal(tableExists(db, 'collector_telemetry_maintenance'), true)
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'idx_collector_runs_finished',
      'idx_collector_source_runs_watermark',
      'idx_collector_source_runs_usage'
    )
  `).get() as { count: number }).count, 3)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  db.prepare(`
    INSERT INTO collector_runs
      (run_id, device_id, report_schema_version, collector_kind,
       collector_version, schedule_interval_minutes, started_at, finished_at,
       status, duration_ms, emitted, accepted, unchanged)
    VALUES (?, ?, 1, 'native', '0.1.0', 30, ?, ?, 'success', 1000, 2, 1, 1)
  `).run('run-1', 'd1', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:01.000Z')
  db.prepare(`
    INSERT INTO collector_source_runs
      (run_id, source, status, discovered, scanned, emitted,
       accepted, unchanged, duration_ms)
    VALUES ('run-1', 'codex', 'success', 3, 2, 2, 1, 1, 900)
  `).run()

  assert.throws(() => db.prepare(`
    INSERT INTO collector_runs
      (run_id, device_id, report_schema_version, collector_kind,
       collector_version, schedule_interval_minutes, started_at, finished_at,
       status, duration_ms, emitted)
    VALUES ('bad', 'd1', 1, 'native', '0.1.0', 30, 'start', 'finish',
      'running', 0, 0)
  `).run(), /CHECK constraint failed/)
  assert.throws(() => db.prepare(`
    INSERT INTO collector_source_runs
      (run_id, source, status, discovered, scanned, emitted,
       accepted, unchanged, duration_ms)
    VALUES ('run-1', 'gemini', 'success', 1, 1, 1, NULL, NULL, 1)
  `).run(), /CHECK constraint failed/)

  runSchemaMigrations(db)
  assert.equal(getSchemaVersion(db), LATEST_SCHEMA_VERSION)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM collector_runs')
    .get() as { count: number }).count, 1)
  db.close()
})

test('security migration stores only constrained session and credential hashes', () => {
  const db = initDB(':memory:')
  for (const table of ['auth_sessions', 'auth_login_events', 'device_credentials']) {
    assert.equal(tableExists(db, table), true)
  }
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  const hash = 'a'.repeat(64)
  db.prepare(`
    INSERT INTO auth_sessions (token_hash, role, expires_at)
    VALUES (?, 'admin', '2026-07-19T00:00:00.000Z')
  `).run(hash)
  db.prepare(`
    INSERT INTO auth_login_events (role, source_hash, outcome, created_at)
    VALUES ('viewer', ?, 'failure', '2026-07-18T00:00:00.000Z')
  `).run('b'.repeat(64))
  db.prepare(`
    INSERT INTO device_credentials
      (token_id, device_id, label, secret_hash, created_at)
    VALUES ('abcdefghijkl', 'd1', 'Primary', ?, '2026-07-18T00:00:00.000Z')
  `).run('c'.repeat(64))
  assert.throws(() => db.prepare(`
    INSERT INTO auth_sessions (token_hash, role, expires_at)
    VALUES ('short', 'admin', '2026-07-19T00:00:00.000Z')
  `).run(), /CHECK constraint failed/)
  assert.throws(() => db.prepare(`
    INSERT INTO device_credentials
      (token_id, device_id, label, secret_hash, created_at)
    VALUES ('another-token', 'd1', 'Bad', 'plaintext', '2026-07-18T00:00:00.000Z')
  `).run(), /CHECK constraint failed/)
  db.prepare('DELETE FROM devices WHERE id = ?').run('d1')
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM device_credentials')
    .get() as { count: number }).count, 0)
  db.close()
})

test('attribution migration adds nullable ledger fields and isolated project memberships', () => {
  const db = createLegacyUsageDatabase()
  runSchemaMigrations(db)
  assert.equal(tableExists(db, 'attribution_project_groups'), true)
  assert.equal(tableExists(db, 'attribution_projects'), true)
  assert.deepEqual(db.prepare(`
    SELECT attribution_version, attribution_status, project_id, session_id
    FROM usage_records ORDER BY id
  `).all(), [
    { attribution_version: null, attribution_status: null, project_id: null, session_id: null },
    { attribution_version: null, attribution_status: null, project_id: null, session_id: null },
  ])
  const group = Number(db.prepare(
    "INSERT INTO attribution_project_groups (display_name) VALUES ('Project A')",
  ).run().lastInsertRowid)
  db.prepare(`
    INSERT INTO attribution_projects
      (device_id, project_id, group_id, first_seen_at, last_seen_at)
    VALUES ('legacy', ?, ?, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')
  `).run(`prj_v1_${'a'.repeat(43)}`, group)
  assert.throws(() => db.prepare(`
    INSERT INTO attribution_projects
      (device_id, project_id, group_id, first_seen_at, last_seen_at)
    VALUES ('legacy', '', ?, 'now', 'now')
  `).run(group), /CHECK constraint failed/)
  db.close()
})

test('alert migration constrains active lifecycle and webhook outbox', () => {
  const db = initDB(':memory:')
  for (const table of [
    'alert_rules', 'alert_rule_evaluations', 'alert_events',
    'alert_webhook_deliveries',
  ]) assert.equal(tableExists(db, table), true)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  const rule = db.prepare(`
    INSERT INTO alert_rules
      (name, kind, device_id, timezone, config_json, cooldown_minutes)
    VALUES ('Daily cost', 'budget', 'd1', 'Asia/Shanghai', ?, 60)
  `).run(JSON.stringify({ period: 'day', metric: 'cost', limit: 10 }))
  const ruleId = Number(rule.lastInsertRowid)
  const insertEvent = db.prepare(`
    INSERT INTO alert_events
      (rule_id, dedup_key, status, severity, first_triggered_at,
       last_triggered_at, cooldown_until, notification_status, evidence_json)
    VALUES (?, 'same-key', 'active', 'warning', ?, ?, ?, 'pending', ?)
  `)
  const now = '2026-07-17T00:00:00.000Z'
  const evidence = JSON.stringify({ kind: 'budget' })
  const event = insertEvent.run(ruleId, now, now, now, evidence)
  assert.throws(() => insertEvent.run(ruleId, now, now, now, evidence), /UNIQUE/)
  assert.throws(() => db.prepare(`
    UPDATE alert_events SET status = 'recovered' WHERE id = ?
  `).run(event.lastInsertRowid), /CHECK constraint failed/)
  db.prepare(`
    INSERT INTO alert_webhook_deliveries
      (event_id, status, next_attempt_at)
    VALUES (?, 'pending', ?)
  `).run(event.lastInsertRowid, now)
  assert.throws(() => db.prepare(`
    UPDATE alert_webhook_deliveries SET attempt_count = 6 WHERE event_id = ?
  `).run(event.lastInsertRowid), /CHECK constraint failed/)
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleId)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM alert_events')
    .get() as { count: number }).count, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM alert_webhook_deliveries')
    .get() as { count: number }).count, 0)
  db.close()
})

test('usage metric migration backfills auditable legacy defaults', () => {
  const db = createLegacyUsageDatabase()

  runSchemaMigrations(db)

  const rows = db.prepare(`
    SELECT provider, request_count, input_includes_cache_read,
      input_includes_cache_creation, output_includes_reasoning
    FROM usage_records ORDER BY provider
  `).all()
  assert.deepEqual(rows, [
    {
      provider: 'codex', request_count: 1,
      input_includes_cache_read: 1,
      input_includes_cache_creation: 0,
      output_includes_reasoning: 0,
    },
    {
      provider: 'hermes', request_count: 1,
      input_includes_cache_read: 0,
      input_includes_cache_creation: 0,
      output_includes_reasoning: 0,
    },
  ])
  assert.throws(() => db.prepare(`
    INSERT INTO usage_records
      (device_id, provider, model, timestamp, dedup_key, request_count)
    VALUES ('legacy', 'hermes', 'mimo', '2025-01-02T00:00:00.000Z', 'bad', -1)
  `).run(), /CHECK constraint failed/)
  db.close()
})

test('pending migrations roll back together and retry safely', () => {
  const db = new Database(':memory:')
  const failing: SchemaMigration[] = [
    { version: 1, name: 'create-first', up: current => current.exec('CREATE TABLE first_table (id INTEGER)') },
    {
      version: 2,
      name: 'create-second',
      up: current => {
        current.exec('CREATE TABLE second_table (id INTEGER)')
        throw new Error('injected migration failure')
      },
    },
  ]

  assert.throws(() => runSchemaMigrations(db, failing), /injected migration failure/)
  assert.equal(tableExists(db, 'first_table'), false)
  assert.equal(tableExists(db, 'second_table'), false)
  assert.equal(getSchemaVersion(db), 0)

  const repaired: SchemaMigration[] = [
    failing[0],
    { version: 2, name: 'create-second', up: current => current.exec('CREATE TABLE second_table (id INTEGER)') },
  ]
  runSchemaMigrations(db, repaired)
  assert.equal(tableExists(db, 'first_table'), true)
  assert.equal(tableExists(db, 'second_table'), true)
  assert.equal(getSchemaVersion(db), 2)
  db.close()
})

test('migration definitions must be strictly ordered and uniquely named', () => {
  const db = new Database(':memory:')
  const noop = () => {}
  assert.throws(() => runSchemaMigrations(db, [
    { version: 2, name: 'later', up: noop },
    { version: 1, name: 'earlier', up: noop },
  ]), /strictly increasing/)
  assert.throws(() => runSchemaMigrations(db, [
    { version: 1, name: 'duplicate', up: noop },
    { version: 2, name: 'duplicate', up: noop },
  ]), /non-empty and unique/)
  db.close()
})

test('older binary rejects a database with a newer schema version', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
    .run(LATEST_SCHEMA_VERSION + 1, 'future-schema')

  assert.throws(() => runSchemaMigrations(db), /newer than supported/)
  db.close()
})

test('applied migration name drift is rejected', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version, name) VALUES (1, 'wrong-name');
  `)

  assert.throws(() => runSchemaMigrations(db, [
    { version: 1, name: 'expected-name', up: () => {} },
  ]), /Unknown schema migration/)
  db.close()
})
