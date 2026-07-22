import assert from 'node:assert/strict'
import test from 'node:test'
import { apiRoutes } from './routes.js'
import { initDB } from './db.js'
import { applyDeviceRekey, planDeviceRekey } from './device-migration.js'

test('device registration stores machine metadata and old clients preserve it', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const register = (body: unknown) => app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const created = await register({
    id: 'machine-1', name: 'MACHINE-1', platform: 'linux',
    architecture: 'x86_64', hostname: 'host-1', native_sources: ['claude', 'codex'],
  })
  assert.equal(created.status, 200)
  assert.equal((await register({ id: 'machine-1', name: 'Machine 1' })).status, 200)
  assert.equal((await register({
    id: 'machine-2', name: 'Machine 2', platform: 'android',
  })).status, 400)
  assert.deepEqual(db.prepare(`
    SELECT name, platform, architecture, hostname FROM devices WHERE id = 'machine-1'
  `).get(), {
    name: 'Machine 1', platform: 'linux', architecture: 'x86_64', hostname: 'host-1',
  })
  assert.equal((db.prepare('SELECT COUNT(*) count FROM devices')
    .get() as { count: number }).count, 1)
  db.close()
})

function seedDeviceReferences() {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO devices
      (id, name, platform, architecture, hostname)
    VALUES ('hermes-27', 'HERMES-27', 'linux', 'x86_64', 'hcss-ecs-58ea')
  `).run()
  db.prepare(`
    INSERT INTO usage_records
      (device_id, provider, model, timestamp, dedup_key)
    VALUES ('hermes-27', 'hermes', 'model', '2026-07-20T00:00:00.000Z', 'usage-1')
  `).run()
  db.prepare(`
    INSERT INTO source_cutovers
      (device_id, provider, cutover_at, legacy_source, native_source)
    VALUES ('hermes-27', 'claude', '2026-07-20T00:00:00.000Z', 'cc-switch', 'claude-code')
  `).run()
  db.prepare(`
    INSERT INTO source_cutover_events
      (device_id, provider, cutover_at, actor, reason)
    VALUES ('hermes-27', 'claude', '2026-07-20T00:00:00.000Z', 'admin', 'test')
  `).run()
  db.prepare(`
    INSERT INTO collector_runs
      (run_id, device_id, report_schema_version, collector_kind, collector_version,
       schedule_interval_minutes, started_at, finished_at, status, duration_ms,
       emitted, accepted, unchanged)
    VALUES ('run-1', 'hermes-27', 1, 'hermes', '0.1.0', 60,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:01.000Z',
      'success', 1000, 0, 0, 0)
  `).run()
  db.prepare(`
    INSERT INTO device_credentials
      (token_id, device_id, label, secret_hash, created_at)
    VALUES ('abcdefghijkl', 'hermes-27', 'Primary', ?, '2026-07-20T00:00:00.000Z')
  `).run('a'.repeat(64))
  db.prepare(`
    INSERT INTO alert_rules
      (name, kind, device_id, timezone, config_json)
    VALUES ('Budget', 'budget', 'hermes-27', 'Asia/Shanghai', '{}')
  `).run()
  const groupId = Number(db.prepare(`
    INSERT INTO attribution_project_groups (display_name) VALUES ('Project')
  `).run().lastInsertRowid)
  db.prepare(`
    INSERT INTO attribution_projects
      (device_id, project_id, group_id, first_seen_at, last_seen_at)
    VALUES ('hermes-27', 'project-1', ?,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')
  `).run(groupId)
  return db
}

test('device rekey plans and atomically moves every machine reference', () => {
  const db = seedDeviceReferences()
  const plan = planDeviceRekey(db, 'hermes-27', 'huawei-27', 'HUAWEI-27')
  assert.deepEqual(plan.counts, {
    usage_records: 1, source_cutovers: 1, source_cutover_events: 1,
    collector_runs: 1, device_credentials: 1, alert_rules: 1,
    attribution_projects: 1,
  })
  const result = applyDeviceRekey(db, plan)
  assert.equal(result.applied, true)
  assert.equal(db.prepare("SELECT 1 FROM devices WHERE id = 'hermes-27'").get(), undefined)
  assert.deepEqual(db.prepare(`
    SELECT name, platform, architecture, hostname FROM devices WHERE id = 'huawei-27'
  `).get(), {
    name: 'HUAWEI-27', platform: 'linux', architecture: 'x86_64',
    hostname: 'hcss-ecs-58ea',
  })
  for (const table of Object.keys(plan.counts)) {
    const row = db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE device_id = 'huawei-27'`)
      .get() as { count: number }
    assert.equal(row.count, 1, table)
  }
  db.close()
})

test('device rekey rejects existing targets without changing either device', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO devices (id, name) VALUES ('old', 'Old'), ('new', 'New')").run()
  assert.throws(
    () => planDeviceRekey(db, 'old', 'new', 'New'),
    /target_exists/,
  )
  assert.equal((db.prepare('SELECT COUNT(*) count FROM devices').get() as { count: number }).count, 2)
  db.close()
})

test('device rekey rolls back every reference when one update fails', () => {
  const db = seedDeviceReferences()
  const plan = planDeviceRekey(db, 'hermes-27', 'huawei-27', 'HUAWEI-27')
  db.exec(`
    CREATE TRIGGER reject_collector_rekey
    BEFORE UPDATE OF device_id ON collector_runs
    BEGIN
      SELECT RAISE(ABORT, 'forced rekey failure');
    END;
  `)

  assert.throws(() => applyDeviceRekey(db, plan), /forced rekey failure/)
  assert.equal(db.prepare("SELECT 1 FROM devices WHERE id = 'huawei-27'").get(), undefined)
  assert.equal(db.prepare("SELECT 1 FROM devices WHERE id = 'hermes-27'").get() != null, true)
  for (const table of Object.keys(plan.counts)) {
    const row = db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE device_id = 'hermes-27'`)
      .get() as { count: number }
    assert.equal(row.count, 1, table)
  }
  db.close()
})

test('device rekey route is dry-run by default and requires backup confirmation', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO devices (id, name) VALUES ('old', 'Old')").run()
  const app = apiRoutes(db)
  const request = (body: unknown) => app.request('/devices/rekey', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  const dryRun = await request({
    device_id: 'old', target_device_id: 'new', target_name: 'New',
  })
  assert.equal(dryRun.status, 200)
  assert.equal((await dryRun.json() as { applied: boolean }).applied, false)
  assert.equal(db.prepare("SELECT 1 FROM devices WHERE id = 'new'").get(), undefined)

  const missingBackup = await request({
    device_id: 'old', target_device_id: 'new', target_name: 'New', apply: true,
  })
  assert.equal(missingBackup.status, 400)
  assert.deepEqual(await missingBackup.json(), { error: 'backup_required' })

  const applied = await request({
    device_id: 'old', target_device_id: 'new', target_name: 'New',
    apply: true, backup_confirmed: true,
  })
  assert.equal(applied.status, 200)
  assert.equal(db.prepare("SELECT 1 FROM devices WHERE id = 'new'").get() != null, true)
  db.close()
})
