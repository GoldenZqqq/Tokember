import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { initDB } from './db.js'
import { normalizeModel } from './model-normalize.js'
import { PRICING_CATALOG, syncPricingCatalog } from './pricing-catalog.js'
import { PRICING_MODES } from './pricing.js'

interface RuleRow {
  id: number
  model: string
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  origin: string
  user_modified: number
}

function readRule(db: ReturnType<typeof initDB>, model: string): RuleRow | undefined {
  return db.prepare(`
    SELECT id, model, input_price, output_price, cache_read_price,
           cache_write_price, origin, user_modified
    FROM pricing_rules WHERE model = ? AND source IS NULL
  `).get(model) as RuleRow | undefined
}

test('catalog entries are unique, global and priced with finite rates', () => {
  const models = PRICING_CATALOG.map(entry => entry.model)
  assert.equal(new Set(models).size, models.length, 'duplicate catalog model')
  for (const entry of PRICING_CATALOG) {
    assert.ok(PRICING_MODES.includes(entry.mode), `${entry.model} mode`)
    for (const price of [
      entry.input_price, entry.output_price,
      entry.cache_read_price, entry.cache_write_price,
    ]) {
      assert.ok(Number.isFinite(price) && price >= 0, `${entry.model} price`)
    }
    assert.equal(entry.model.trim(), entry.model, `${entry.model} is untrimmed`)
    // A spelling that normalizeModel folds elsewhere would create a second rule
    // for one model and split its usage between them.
    assert.equal(normalizeModel(entry.model), entry.model, `${entry.model} is an alias`)
  }
})

test('catalog prices Sonnet 5 at the standard rate, not the expiring promo', () => {
  // A catalog ships with a release and then sits in databases for months, so a
  // price with an expiry date would silently undercount every deployment that
  // upgraded late. Overcounting until the promo ends is the safer direction.
  const sonnet5 = PRICING_CATALOG.find(entry => entry.model === 'claude-sonnet-5')
  assert.ok(sonnet5)
  assert.deepEqual([
    sonnet5.input_price, sonnet5.output_price,
    sonnet5.cache_read_price, sonnet5.cache_write_price,
  ], [3, 15, 0.3, 3.75])
})

test('a fresh database ships the catalog as builtin global rules', () => {
  const db = initDB(':memory:')
  const rules = db.prepare(`
    SELECT model, origin, user_modified, source FROM pricing_rules
  `).all() as Array<RuleRow & { source: string | null }>

  assert.equal(rules.length, PRICING_CATALOG.length)
  for (const rule of rules) {
    assert.equal(rule.origin, 'builtin', `${rule.model} origin`)
    assert.equal(rule.user_modified, 0, `${rule.model} user_modified`)
    assert.equal(rule.source, null, `${rule.model} source`)
  }
  const opus = readRule(db, 'claude-opus-5')
  assert.deepEqual(
    opus && [opus.input_price, opus.output_price, opus.cache_read_price, opus.cache_write_price],
    [5, 25, 0.5, 6.25],
  )
  db.close()
})

test('catalog sync is idempotent and reports no work on the second run', () => {
  const db = initDB(':memory:')
  const before = (db.prepare('SELECT COUNT(*) AS count FROM pricing_rules')
    .get() as { count: number }).count

  const again = syncPricingCatalog(db)

  assert.deepEqual(again, { inserted: 0, updated: 0, preserved: 0 })
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM pricing_rules')
    .get() as { count: number }).count, before)
  db.close()
})

test('catalog corrects an untouched builtin price but never a user-owned one', () => {
  const db = initDB(':memory:')
  // Simulate a shipped price we later fixed upstream.
  db.prepare(`
    UPDATE pricing_rules SET input_price = 999 WHERE model = 'claude-opus-5'
  `).run()
  // Simulate an operator's gateway rate on another builtin rule.
  db.prepare(`
    UPDATE pricing_rules SET input_price = 1.23, user_modified = 1
    WHERE model = 'claude-sonnet-4-6'
  `).run()

  const result = syncPricingCatalog(db)

  assert.equal(result.updated, 1)
  assert.equal(result.preserved, 1)
  assert.equal(result.inserted, 0)
  assert.equal(readRule(db, 'claude-opus-5')?.input_price, 5)
  assert.equal(readRule(db, 'claude-sonnet-4-6')?.input_price, 1.23)
  db.close()
})

test('catalog leaves operator-created rules and source overrides alone', () => {
  const db = initDB(':memory:')
  // An operator-owned global rule for a model the catalog also carries.
  db.prepare(`
    UPDATE pricing_rules SET input_price = 4.2, origin = 'user'
    WHERE model = 'claude-opus-4-8'
  `).run()
  // A gateway override must survive untouched, and must not be counted twice.
  db.prepare(`
    INSERT INTO pricing_rules
      (source, model, mode, input_price, output_price, cache_read_price,
       cache_write_price, enabled, origin, user_modified)
    VALUES ('hermes', 'claude-opus-5', 'priced', 0.5, 2, 0.05, 0.6, 1, 'user', 0)
  `).run()

  const result = syncPricingCatalog(db)

  assert.equal(result.preserved, 1)
  assert.equal(result.inserted, 0)
  assert.equal(result.updated, 0)
  assert.equal(readRule(db, 'claude-opus-4-8')?.input_price, 4.2)
  assert.equal((db.prepare(`
    SELECT input_price FROM pricing_rules WHERE source = 'hermes'
  `).get() as { input_price: number }).input_price, 0.5)
  db.close()
})

test('existing databases keep their rules as user-owned and get repriced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokember-catalog-'))
  const path = join(directory, 'existing.db')
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
    CREATE TABLE pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, model TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'priced', input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0, cache_read_price REAL NOT NULL DEFAULT 0,
      cache_write_price REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO devices VALUES ('d1', 'Device');
    -- A hand-tuned gateway rate that upgrades must not touch.
    INSERT INTO pricing_rules (model, input_price, output_price, cache_read_price)
    VALUES ('mimo-v2.5-pro', 0.435, 0.87, 0.0036);
    INSERT INTO usage_records
      (device_id, provider, model, input_tokens, output_tokens, timestamp, dedup_key)
    VALUES ('d1', 'claude', 'claude-opus-5', 1000000, 0, datetime('now'), 'opus5');
  `)
  legacy.close()

  const db = initDB(path)

  const preserved = readRule(db, 'mimo-v2.5-pro')
  assert.equal(preserved?.origin, 'user')
  assert.equal(preserved?.input_price, 0.435)
  assert.equal(preserved?.cache_read_price, 0.0036)
  // The catalog rule now exists, so the previously unpriced row is costed.
  assert.deepEqual(db.prepare(`
    SELECT pricing_status, cost_usd FROM usage_records WHERE dedup_key = 'opus5'
  `).get(), { pricing_status: 'priced', cost_usd: 5 })
  db.close()
  rmSync(directory, { recursive: true, force: true })
})
