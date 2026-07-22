import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { initDB } from './db.js'
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from './migrations.js'
import { calculateRuleCost, repriceUnpricedRecords, resolvePricing, type PricingRule } from './pricing.js'

const rule: PricingRule = {
  id: 1, source: null, model: 'model-a', mode: 'priced',
  input_price: 2, output_price: 8, cache_read_price: 0.2, cache_write_price: 3,
  enabled: 1, created_at: '', updated_at: '',
}

test('migrates the legacy usage schema idempotently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokember-migration-'))
  const path = join(directory, 'legacy.db')
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, timestamp TEXT NOT NULL, source_file TEXT,
      dedup_key TEXT UNIQUE, created_at TEXT
    );
    INSERT INTO devices VALUES ('d1', 'Device'), ('sub2api', 'sub2api');
    INSERT INTO usage_records
      (device_id, provider, model, input_tokens, cost_usd, timestamp, dedup_key)
    VALUES ('d1', 'codex', 'priced', 10, 1.5, datetime('now'), 'a'),
           ('d1', 'hermes', 'unknown', 10, 0, datetime('now'), 'b'),
           ('sub2api', 'sub2api', 'gateway', 10, 1, datetime('now'), 'gateway'),
           ('sub2api', 'hermes', 'mimo-v2.5-pro', 10, 0, datetime('now'), 'gateway-hermes');
    UPDATE usage_records SET source_file = 'hermes:custom:unknown'
    WHERE dedup_key = 'gateway-hermes';
  `)
  legacy.close()
  const migrated = initDB(path)
  const rows = migrated.prepare('SELECT dedup_key, pricing_status FROM usage_records ORDER BY dedup_key').all() as { dedup_key: string; pricing_status: string }[]
  assert.deepEqual(rows, [
    { dedup_key: 'a', pricing_status: 'provided' },
    { dedup_key: 'b', pricing_status: 'unpriced' },
    { dedup_key: 'gateway-hermes', pricing_status: 'unpriced' },
  ])
  assert.equal((migrated.prepare(`
    SELECT COUNT(*) AS count FROM devices WHERE id = 'sub2api'
  `).get() as { count: number }).count, 0)
  assert.equal((migrated.prepare(`
    SELECT COUNT(*) AS count FROM app_migrations
    WHERE name = '2026-07-16-activity-only-remove-sub2api'
  `).get() as { count: number }).count, 1)
  assert.deepEqual(migrated.prepare(`
    SELECT device_id, provider, source_file FROM usage_records
    WHERE dedup_key = 'gateway-hermes'
  `).get(), {
    device_id: 'hermes-27', provider: 'hermes', source_file: 'hermes:custom:unknown',
  })
  assert.ok(migrated.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_aliases'
  `).get())
  assert.ok(migrated.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_cutovers'
  `).get())
  assert.equal(getSchemaVersion(migrated), LATEST_SCHEMA_VERSION)
  migrated.close()
  const reopened = initDB(path)
  assert.equal(getSchemaVersion(reopened), LATEST_SCHEMA_VERSION)
  reopened.close()
  rmSync(directory, { recursive: true, force: true })
})

test('migrates provider pricing rules into global rules and source overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokember-pricing-migration-'))
  const path = join(directory, 'legacy.db')
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, timestamp TEXT NOT NULL, source_file TEXT,
      dedup_key TEXT UNIQUE, created_at TEXT, pricing_status TEXT NOT NULL DEFAULT 'unpriced',
      pricing_rule_id INTEGER, pricing_source TEXT
    );
    CREATE TABLE pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'priced', input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0, cache_read_price REAL NOT NULL DEFAULT 0,
      cache_write_price REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(provider, model)
    );
    INSERT INTO devices VALUES ('d1', 'Device');
    INSERT INTO pricing_rules
      (id, provider, model, input_price, output_price, cache_read_price)
    VALUES (1, 'claude', 'same-model', 2, 6, 0.5),
           (2, 'hermes', 'same-model', 2, 6, 0.5),
           (3, 'claude', 'conflict-model', 1, 3, 0.1),
           (4, 'hermes', 'conflict-model', 2, 6, 0.2);
    INSERT INTO usage_records
      (device_id, provider, model, timestamp, dedup_key, pricing_status,
       pricing_rule_id, pricing_source)
    VALUES ('d1', 'hermes', 'same-model', datetime('now'), 'merged', 'priced', 2, 'rule:2');
  `)
  legacy.close()

  const migrated = initDB(path)
  const columns = migrated.prepare('PRAGMA table_info(pricing_rules)').all() as { name: string }[]
  assert.ok(columns.some(column => column.name === 'source'))
  assert.ok(!columns.some(column => column.name === 'provider'))
  assert.deepEqual(migrated.prepare(`
    SELECT id, source, model, input_price FROM pricing_rules ORDER BY id
  `).all(), [
    { id: 1, source: null, model: 'same-model', input_price: 2 },
    { id: 3, source: 'claude', model: 'conflict-model', input_price: 1 },
    { id: 4, source: 'hermes', model: 'conflict-model', input_price: 2 },
  ])
  assert.deepEqual(migrated.prepare(`
    SELECT pricing_rule_id, pricing_source FROM usage_records WHERE dedup_key = 'merged'
  `).get(), { pricing_rule_id: 1, pricing_source: 'rule:1' })
  migrated.close()

  const reopened = initDB(path)
  assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM pricing_rules').get() as { count: number }).count, 3)
  reopened.close()
  rmSync(directory, { recursive: true, force: true })
})

test('calculates four-part token pricing', () => {
  const cost = calculateRuleCost(rule, {
    provider: 'hermes', model: 'model-a', input_tokens: 1_000_000,
    output_tokens: 100_000, cache_read_tokens: 500_000,
    cache_creation_tokens: 20_000,
  })
  assert.equal(cost, 2.96)
})

test('normalizes cache-inclusive codex input', () => {
  const cost = calculateRuleCost(rule, {
    provider: 'codex', model: 'model-a', input_tokens: 1_000_000,
    output_tokens: 0, cache_read_tokens: 600_000, cache_creation_tokens: 0,
  })
  assert.equal(cost, 0.92)
})

test('preserves collector-provided positive cost', () => {
  const db = initDB(':memory:')
  const result = resolvePricing(db, {
    provider: 'hermes', model: 'model-a', input_tokens: 100,
    output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 4.2,
  })
  assert.equal(result.pricing_status, 'provided')
  assert.equal(result.cost_usd, 4.2)
  db.close()
})

test('preserves explicitly provided zero cost', () => {
  const db = initDB(':memory:')
  const result = resolvePricing(db, {
    provider: 'sub2api', model: 'free-model', input_tokens: 100,
    output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: 0, cost_provided: true,
  })
  assert.equal(result.pricing_status, 'provided')
  assert.equal(result.cost_usd, 0)
  db.close()
})

test('marks free and included usage as priced states with zero cost', () => {
  const db = initDB(':memory:')
  const insert = db.prepare(`
    INSERT INTO pricing_rules (model, mode) VALUES (?, ?)
  `)
  insert.run('free-model', 'free')
  insert.run('included-model', 'included')
  for (const mode of ['free', 'included'] as const) {
    const result = resolvePricing(db, {
      provider: 'hermes', model: `${mode}-model`, input_tokens: 100,
      output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0,
    })
    assert.equal(result.pricing_status, mode)
    assert.equal(result.cost_usd, 0)
  }
  db.close()
})

test('prefers a source override and falls back to the global model rule', () => {
  const db = initDB(':memory:')
  const insert = db.prepare(`
    INSERT INTO pricing_rules
      (source, model, input_price, output_price, cache_read_price, cache_write_price, enabled)
    VALUES (?, 'shared-model', ?, 0, 0, 0, ?)
  `)
  insert.run(null, 2, 1)
  insert.run('hermes', 5, 1)
  insert.run('codex', 8, 0)

  const usage = {
    model: 'shared-model', input_tokens: 1_000_000, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
  }
  const override = resolvePricing(db, { ...usage, provider: 'hermes' })
  const fallback = resolvePricing(db, { ...usage, provider: 'claude' })
  const disabledFallback = resolvePricing(db, { ...usage, provider: 'codex' })
  assert.equal(override.cost_usd, 5)
  assert.equal(fallback.cost_usd, 2)
  assert.equal(disabledFallback.cost_usd, 2)
  db.close()
})

test('previews and applies only unpriced rows', () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  db.prepare(`
    INSERT INTO pricing_rules
      (model, mode, input_price, output_price, cache_read_price, cache_write_price)
    VALUES ('model-a', 'priced', 2, 8, 0.2, 3)
  `).run()
  db.prepare(`
    INSERT INTO usage_records
      (device_id, provider, model, input_tokens, output_tokens, timestamp,
       dedup_key, pricing_status)
    VALUES ('d1', 'hermes', 'model-a', 1000000, 100000, datetime('now'), 'a', 'unpriced')
  `).run()

  const preview = repriceUnpricedRecords(db, false)
  assert.equal(preview.matched, 1)
  const before = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: number }
  assert.equal(before.cost_usd, 0)
  const applied = repriceUnpricedRecords(db, true)
  assert.equal(applied.matched, 1)
  const after = db.prepare('SELECT pricing_status FROM usage_records').get() as { pricing_status: string }
  assert.equal(after.pricing_status, 'priced')
  db.close()
})

test('batch reprice loads candidates and enabled rules once', () => {
  const statements: string[] = []
  const db = new Database(':memory:', { verbose: sql => statements.push(String(sql)) })
  db.exec(`
    CREATE TABLE pricing_rules (
      id INTEGER PRIMARY KEY, source TEXT, model TEXT, mode TEXT,
      input_price REAL, output_price REAL, cache_read_price REAL,
      cache_write_price REAL, enabled INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY, provider TEXT, model TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      reasoning_tokens INTEGER, input_includes_cache_read INTEGER,
      input_includes_cache_creation INTEGER, output_includes_reasoning INTEGER,
      cost_usd REAL, pricing_status TEXT, pricing_rule_id INTEGER, pricing_source TEXT
    );
    INSERT INTO pricing_rules VALUES
      (1, NULL, 'model-a', 'priced', 2, 8, 0.2, 3, 1, '', '');
  `)
  const insert = db.prepare(`
    INSERT INTO usage_records VALUES
      (?, 'hermes', 'model-a', 1000, 100, 0, 0, 0, 0, 0, 0, 0,
       'unpriced', NULL, NULL)
  `)
  for (let id = 1; id <= 12; id += 1) insert.run(id)
  statements.length = 0

  const preview = repriceUnpricedRecords(db, false)
  const selects = statements.filter(sql => sql.trimStart().startsWith('SELECT'))

  assert.equal(preview.matched, 12)
  assert.equal(selects.length, 2)
  db.close()
})
