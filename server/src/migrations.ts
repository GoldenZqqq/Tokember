import type { Database as DatabaseType } from 'better-sqlite3'

export interface SchemaMigration {
  version: number
  name: string
  up: (db: DatabaseType) => void
}

interface AppliedMigration {
  version: number
  name: string
}

interface LegacyPricingRule {
  id: number
  provider: string
  model: string
  mode: string
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  enabled: number
  created_at: string
  updated_at: string
}

function hasTable(db: DatabaseType, table: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) != null
}

function hasColumn(db: DatabaseType, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return columns.some(item => item.name === column)
}

function ensureSchemaMigrationsTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function ensureUsagePricingColumns(db: DatabaseType): void {
  const columns = [
    ['pricing_status', "TEXT NOT NULL DEFAULT 'unpriced'"],
    ['pricing_rule_id', 'INTEGER'],
    ['pricing_source', 'TEXT'],
  ]
  for (const [name, definition] of columns) {
    if (!hasColumn(db, 'usage_records', name)) {
      db.exec(`ALTER TABLE usage_records ADD COLUMN ${name} ${definition}`)
    }
  }
  db.exec(`
    UPDATE usage_records SET pricing_status = 'provided', pricing_source = 'collector'
    WHERE pricing_status = 'unpriced' AND cost_usd > 0;
    UPDATE usage_records SET pricing_status = 'none'
    WHERE pricing_status = 'unpriced'
      AND input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens = 0;
  `)
}

function ensureDeviceHeartbeatColumns(db: DatabaseType): void {
  for (const name of ['last_seen_at', 'prev_seen_at']) {
    if (!hasColumn(db, 'devices', name)) {
      db.exec(`ALTER TABLE devices ADD COLUMN ${name} TEXT`)
    }
  }
  db.exec(`
    UPDATE devices SET last_seen_at = (
      SELECT MAX(created_at) FROM usage_records WHERE device_id = devices.id
    )
    WHERE last_seen_at IS NULL
  `)
}

function ensureDeviceMachineMetadata(db: DatabaseType): void {
  const columns = [
    ['platform', "TEXT CHECK(platform IS NULL OR platform IN ('windows', 'macos', 'linux', 'other'))"],
    ['architecture', 'TEXT CHECK(architecture IS NULL OR length(trim(architecture)) BETWEEN 1 AND 40)'],
    ['hostname', 'TEXT CHECK(hostname IS NULL OR length(trim(hostname)) BETWEEN 1 AND 255)'],
  ]
  for (const [name, definition] of columns) {
    if (!hasColumn(db, 'devices', name)) {
      db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${definition}`)
    }
  }
}

function createPricingRulesTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      model TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'priced' CHECK(mode IN ('priced', 'free', 'included')),
      input_price REAL NOT NULL DEFAULT 0 CHECK(input_price >= 0),
      output_price REAL NOT NULL DEFAULT 0 CHECK(output_price >= 0),
      cache_read_price REAL NOT NULL DEFAULT 0 CHECK(cache_read_price >= 0),
      cache_write_price REAL NOT NULL DEFAULT 0 CHECK(cache_write_price >= 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function createPricingRuleIndexes(db: DatabaseType): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_global_model
      ON pricing_rules(model) WHERE source IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_source_model
      ON pricing_rules(source, model) WHERE source IS NOT NULL;
  `)
}

function pricingSignature(rule: LegacyPricingRule): string {
  return JSON.stringify([
    rule.mode, rule.input_price, rule.output_price,
    rule.cache_read_price, rule.cache_write_price, rule.enabled,
  ])
}

function insertMigratedRule(
  db: DatabaseType,
  rule: LegacyPricingRule,
  source: string | null,
): void {
  db.prepare(`
    INSERT INTO pricing_rules
      (id, source, model, mode, input_price, output_price,
       cache_read_price, cache_write_price, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.id, source, rule.model, rule.mode, rule.input_price, rule.output_price,
    rule.cache_read_price, rule.cache_write_price, rule.enabled,
    rule.created_at, rule.updated_at,
  )
}

function migrateLegacyPricingRules(db: DatabaseType): void {
  const rules = db.prepare('SELECT * FROM pricing_rules ORDER BY id').all() as LegacyPricingRule[]
  const groups = new Map<string, LegacyPricingRule[]>()
  for (const rule of rules) groups.set(rule.model, [...(groups.get(rule.model) ?? []), rule])

  db.exec('ALTER TABLE pricing_rules RENAME TO pricing_rules_legacy')
  createPricingRulesTable(db)
  const remappedIds = new Map<number, number>()
  for (const group of groups.values()) {
    const canonical = group[0]
    const identical = group.every(rule => pricingSignature(rule) === pricingSignature(canonical))
    if (identical) {
      insertMigratedRule(db, canonical, null)
      for (const rule of group) remappedIds.set(rule.id, canonical.id)
    } else {
      for (const rule of group) {
        insertMigratedRule(db, rule, rule.provider)
        remappedIds.set(rule.id, rule.id)
      }
    }
  }
  const updateId = db.prepare('UPDATE usage_records SET pricing_rule_id = ? WHERE pricing_rule_id = ?')
  const updateSource = db.prepare('UPDATE usage_records SET pricing_source = ? WHERE pricing_source = ?')
  for (const [oldId, newId] of remappedIds) {
    if (oldId === newId) continue
    updateId.run(newId, oldId)
    updateSource.run(`rule:${newId}`, `rule:${oldId}`)
  }
  db.exec('DROP TABLE pricing_rules_legacy')
}

function ensurePricingRulesSchema(db: DatabaseType): void {
  if (!hasTable(db, 'pricing_rules')) createPricingRulesTable(db)
  if (hasColumn(db, 'pricing_rules', 'provider')) migrateLegacyPricingRules(db)
  createPricingRuleIndexes(db)
}

function ensureModelAliasesSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pricing_rule_id INTEGER NOT NULL
        REFERENCES pricing_rules(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(length(trim(source)) > 0),
      alias TEXT NOT NULL CHECK(length(trim(alias)) > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, alias)
    );
    CREATE INDEX IF NOT EXISTS idx_model_aliases_rule
      ON model_aliases(pricing_rule_id);
  `)
}

function ensureUsageMetricColumns(db: DatabaseType): void {
  const columns = [
    ['request_count', 'INTEGER NOT NULL DEFAULT 1 CHECK(request_count >= 0 AND typeof(request_count) = \'integer\')'],
    ['input_includes_cache_read', 'INTEGER NOT NULL DEFAULT 0 CHECK(input_includes_cache_read IN (0, 1))'],
    ['input_includes_cache_creation', 'INTEGER NOT NULL DEFAULT 0 CHECK(input_includes_cache_creation IN (0, 1))'],
    ['output_includes_reasoning', 'INTEGER NOT NULL DEFAULT 0 CHECK(output_includes_reasoning IN (0, 1))'],
  ]
  for (const [name, definition] of columns) {
    if (!hasColumn(db, 'usage_records', name)) {
      db.exec(`ALTER TABLE usage_records ADD COLUMN ${name} ${definition}`)
    }
  }
  db.exec(`
    UPDATE usage_records SET input_includes_cache_read = 1
    WHERE provider IN ('codex', 'gemini');
  `)
}

function ensureCollectorRunTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collector_runs (
      run_id TEXT PRIMARY KEY CHECK(length(run_id) BETWEEN 1 AND 120),
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      report_schema_version INTEGER NOT NULL CHECK(report_schema_version = 1),
      collector_kind TEXT NOT NULL CHECK(collector_kind IN ('native', 'hermes')),
      collector_version TEXT NOT NULL CHECK(length(collector_version) BETWEEN 1 AND 80),
      schedule_interval_minutes INTEGER NOT NULL
        CHECK(schedule_interval_minutes BETWEEN 1 AND 10080),
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success', 'partial', 'failed')),
      duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
      emitted INTEGER NOT NULL CHECK(emitted >= 0),
      accepted INTEGER CHECK(accepted IS NULL OR accepted >= 0),
      unchanged INTEGER CHECK(unchanged IS NULL OR unchanged >= 0),
      error_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((accepted IS NULL) = (unchanged IS NULL)),
      CHECK(accepted IS NULL OR accepted + unchanged <= emitted)
    );

    CREATE TABLE IF NOT EXISTS collector_source_runs (
      run_id TEXT NOT NULL REFERENCES collector_runs(run_id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
      status TEXT NOT NULL
        CHECK(status IN ('success', 'collection_failed', 'upload_failed')),
      discovered INTEGER NOT NULL CHECK(discovered >= 0),
      scanned INTEGER NOT NULL CHECK(scanned >= 0),
      emitted INTEGER NOT NULL CHECK(emitted >= 0),
      accepted INTEGER CHECK(accepted IS NULL OR accepted >= 0),
      unchanged INTEGER CHECK(unchanged IS NULL OR unchanged >= 0),
      watermark_at TEXT,
      last_usage_at TEXT,
      duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
      error_summary TEXT,
      PRIMARY KEY (run_id, source),
      CHECK((accepted IS NULL) = (unchanged IS NULL)),
      CHECK(accepted IS NULL OR accepted + unchanged <= emitted),
      CHECK(status <> 'success' OR (
        accepted IS NOT NULL AND unchanged IS NOT NULL
        AND accepted + unchanged = emitted
      ))
    );

    CREATE INDEX IF NOT EXISTS idx_collector_runs_device_finished
      ON collector_runs(device_id, finished_at DESC);
    CREATE INDEX IF NOT EXISTS idx_collector_source_runs_source
      ON collector_source_runs(source, run_id);
  `)
}

function createAlertRuleTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
      kind TEXT NOT NULL CHECK(kind IN ('budget', 'spike', 'source_health', 'unpriced_growth')),
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      provider TEXT CHECK(provider IS NULL OR length(trim(provider)) BETWEEN 1 AND 80),
      timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 120),
      config_json TEXT NOT NULL CHECK(json_valid(config_json)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      cooldown_minutes INTEGER NOT NULL DEFAULT 60
        CHECK(cooldown_minutes BETWEEN 0 AND 10080),
      notify_webhook INTEGER NOT NULL DEFAULT 0 CHECK(notify_webhook IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS alert_rule_evaluations (
      rule_id INTEGER PRIMARY KEY REFERENCES alert_rules(id) ON DELETE CASCADE,
      evaluated_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ok', 'triggered', 'insufficient_data', 'error')),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
      evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json))
    );
  `)
}

function createAlertEventTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
      dedup_key TEXT NOT NULL CHECK(length(dedup_key) BETWEEN 1 AND 240),
      status TEXT NOT NULL CHECK(status IN ('active', 'recovered')),
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
      first_triggered_at TEXT NOT NULL,
      last_triggered_at TEXT NOT NULL,
      recovered_at TEXT,
      acknowledged_at TEXT,
      cooldown_until TEXT NOT NULL,
      notification_status TEXT NOT NULL CHECK(notification_status IN (
        'not_requested', 'not_configured', 'cooldown', 'pending', 'delivered', 'failed'
      )),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((status = 'active' AND recovered_at IS NULL)
        OR (status = 'recovered' AND recovered_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_active_dedup
      ON alert_events(dedup_key) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_alert_events_rule_latest
      ON alert_events(rule_id, id DESC);
  `)
}

function createAlertDeliveryTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL UNIQUE REFERENCES alert_events(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
      next_attempt_at TEXT NOT NULL,
      last_attempt_at TEXT,
      delivered_at TEXT,
      last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) <= 80),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_due
      ON alert_webhook_deliveries(status, next_attempt_at, id);
  `)
}

function ensureAlertTables(db: DatabaseType): void {
  createAlertRuleTables(db)
  createAlertEventTable(db)
  createAlertDeliveryTable(db)
}

function createAuthSessionTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      role TEXT NOT NULL CHECK(role IN ('viewer', 'admin')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS auth_login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('viewer', 'admin')),
      source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
      outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'rate_limited')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_login_events_window
      ON auth_login_events(role, source_hash, created_at DESC);
  `)
}

function createDeviceCredentialTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL UNIQUE CHECK(length(token_id) BETWEEN 12 AND 64),
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 120),
      secret_hash TEXT NOT NULL CHECK(length(secret_hash) = 64),
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_device_credentials_device
      ON device_credentials(device_id, revoked_at, id DESC);
  `)
}

function ensureSecurityTables(db: DatabaseType): void {
  createAuthSessionTables(db)
  createDeviceCredentialTable(db)
}

function ensureUsageAttributionSchema(db: DatabaseType): void {
  const columns = [
    ['attribution_version', 'INTEGER CHECK(attribution_version = 1)'],
    ['attribution_status', "TEXT CHECK(attribution_status IN ('captured', 'disabled', 'unsupported'))"],
    ['project_id', 'TEXT CHECK(project_id IS NULL OR length(project_id) BETWEEN 1 AND 96)'],
    ['session_id', 'TEXT CHECK(session_id IS NULL OR length(session_id) BETWEEN 1 AND 96)'],
  ]
  for (const [name, definition] of columns) {
    if (!hasColumn(db, 'usage_records', name)) {
      db.exec(`ALTER TABLE usage_records ADD COLUMN ${name} ${definition}`)
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS attribution_project_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT CHECK(
        display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 120
      ),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS attribution_projects (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 96),
      group_id INTEGER NOT NULL
        REFERENCES attribution_project_groups(id) ON DELETE RESTRICT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (device_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attribution_projects_group
      ON attribution_projects(group_id, device_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_usage_attribution_project
      ON usage_records(device_id, project_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_attribution_session
      ON usage_records(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_attribution_status
      ON usage_records(attribution_status, timestamp);
  `)
}

function ensureCollectorTelemetryRetentionSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collector_telemetry_maintenance (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      last_attempted_at TEXT,
      coverage_since TEXT
    );
    INSERT OR IGNORE INTO collector_telemetry_maintenance (id)
      VALUES (1);
    CREATE INDEX IF NOT EXISTS idx_collector_runs_finished
      ON collector_runs(finished_at, run_id);
    CREATE INDEX IF NOT EXISTS idx_collector_source_runs_watermark
      ON collector_source_runs(source, watermark_at, run_id);
    CREATE INDEX IF NOT EXISTS idx_collector_source_runs_usage
      ON collector_source_runs(source, last_usage_at, run_id);
  `)
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, name: 'usage-pricing-columns', up: ensureUsagePricingColumns },
  { version: 2, name: 'device-heartbeat-columns', up: ensureDeviceHeartbeatColumns },
  { version: 3, name: 'pricing-rules-source-scope', up: ensurePricingRulesSchema },
  { version: 4, name: 'model-aliases', up: ensureModelAliasesSchema },
  { version: 5, name: 'usage-metrics-v2', up: ensureUsageMetricColumns },
  { version: 6, name: 'collector-runs', up: ensureCollectorRunTables },
  { version: 7, name: 'budget-anomaly-alerts', up: ensureAlertTables },
  { version: 8, name: 'security-privacy-hardening', up: ensureSecurityTables },
  { version: 9, name: 'project-session-attribution', up: ensureUsageAttributionSchema },
  { version: 10, name: 'device-machine-metadata', up: ensureDeviceMachineMetadata },
  { version: 11, name: 'collector-telemetry-retention', up: ensureCollectorTelemetryRetentionSchema },
]

export const LATEST_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)?.version ?? 0

function validateDefinitions(migrations: readonly SchemaMigration[]): void {
  let previous = 0
  const names = new Set<string>()
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error('Schema migration versions must be positive and strictly increasing')
    }
    const name = migration.name.trim()
    if (!name || names.has(name)) throw new Error('Schema migration names must be non-empty and unique')
    previous = migration.version
    names.add(name)
  }
}

export function getSchemaVersion(db: DatabaseType): number {
  if (!hasTable(db, 'schema_migrations')) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null }
  return row.version ?? 0
}

export function runSchemaMigrations(
  db: DatabaseType,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS,
): void {
  validateDefinitions(migrations)
  ensureSchemaMigrationsTable(db)
  const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[]
  const latestKnown = migrations.at(-1)?.version ?? 0
  const latestApplied = applied.at(-1)?.version ?? 0
  if (latestApplied > latestKnown) {
    throw new Error(`Database schema version ${latestApplied} is newer than supported ${latestKnown}`)
  }

  const definitions = new Map(migrations.map(migration => [migration.version, migration]))
  for (const migration of applied) {
    const expected = definitions.get(migration.version)
    if (!expected || expected.name !== migration.name) {
      throw new Error(`Unknown schema migration ${migration.version}:${migration.name}`)
    }
  }

  const appliedVersions = new Set(applied.map(migration => migration.version))
  const pending = migrations.filter(migration => !appliedVersions.has(migration.version))
  if (pending.length === 0) return
  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
  db.transaction(() => {
    for (const migration of pending) {
      migration.up(db)
      record.run(migration.version, migration.name)
    }
  })()
}
