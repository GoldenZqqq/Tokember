import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuditAdminRecord, AuditRecordsPage } from '@tokember/contracts/audit'
import { getAuditExport } from './audit.js'
import { initDB, type DB } from './db.js'
import { apiRoutes } from './routes.js'

process.env.TOKEMBER_ADMIN_PASSWORD = 'development'
delete process.env.TOKEMBER_API_KEY

type App = ReturnType<typeof apiRoutes>

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie')
  assert.ok(header)
  return header.split(';')[0]
}

async function adminCookie(app: App): Promise<string> {
  const response = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  assert.equal(response.status, 200)
  return cookieFrom(response)
}

function insertDevice(db: DB, id = 'd1'): void {
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(id, `Device ${id}`)
}

function insertUsage(
  db: DB,
  options: {
    dedup: string
    timestamp: string
    provider?: string
    source?: string
    model?: string
    cost?: number
    pricingStatus?: string
    ruleId?: number | null
  },
): number {
  const result = db.prepare(`INSERT INTO usage_records
    (device_id, provider, model, input_tokens, output_tokens, cost_usd,
     timestamp, source_file, dedup_key, pricing_status, pricing_rule_id)
    VALUES ('d1', ?, ?, 1000000, 10, ?, ?, ?, ?, ?, ?)`
  ).run(options.provider ?? 'hermes', options.model ?? 'model', options.cost ?? 0,
    options.timestamp, options.source ?? 'test-source', options.dedup,
    options.pricingStatus ?? 'unpriced', options.ruleId ?? null)
  return Number(result.lastInsertRowid)
}

function isoWindow(center: string): string {
  const since = new Date(Date.parse(center) - 60_000).toISOString()
  const until = new Date(Date.parse(center) + 60_000).toISOString()
  return `since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`
}

test('public records use a stable keyset snapshot and reject cursor reuse', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const at = new Date(Date.now() - 60_000).toISOString()
  const initial = ['a', 'b', 'c'].map(dedup => insertUsage(db, { dedup, timestamp: at }))
  const app = apiRoutes(db)
  const firstResponse = await app.request(`/records?${isoWindow(at)}&limit=2`)
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as AuditRecordsPage
  assert.equal(first.snapshot.max_record_id, initial.at(-1))
  assert.ok(first.next_cursor)
  assert.ok(first.rows.every(row => !('dedup_key' in row) && !('source_file' in row)))

  const concurrent = insertUsage(db, { dedup: 'later', timestamp: at })
  db.prepare('UPDATE usage_records SET cost_usd = 7 WHERE id = ?').run(initial[0])
  const second = await (await app.request(
    `/records?${isoWindow(at)}&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`,
  )).json() as AuditRecordsPage
  const ids = [...first.rows, ...second.rows].map(row => row.id)
  assert.equal(new Set(ids).size, 3)
  assert.ok(!ids.includes(concurrent))
  assert.equal(second.rows.find(row => row.id === initial[0])?.cost_usd, 7)

  const mismatch = await app.request(
    `/records?${isoWindow(at)}&provider=codex&cursor=${encodeURIComponent(first.next_cursor!)}`,
  )
  assert.equal(mismatch.status, 400)
  assert.equal((await mismatch.json() as { code: string }).code, 'cursor_filter_mismatch')
  assert.equal((await app.request('/records?offset=1')).status, 400)
  db.close()
})

test('audit summary separates authoritative physical and hidden records', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const cutover = new Date(Date.now() - 120_000).toISOString()
  const before = new Date(Date.parse(cutover) - 1_000).toISOString()
  const after = new Date(Date.parse(cutover) + 1_000).toISOString()
  insertUsage(db, { dedup: 'legacy-before', timestamp: before, provider: 'claude', source: 'cc-switch' })
  insertUsage(db, { dedup: 'legacy-after', timestamp: after, provider: 'claude', source: 'cc-switch' })
  insertUsage(db, { dedup: 'native-before', timestamp: before, provider: 'claude', source: 'claude-code' })
  insertUsage(db, { dedup: 'native-after', timestamp: after, provider: 'claude', source: 'claude-code' })
  db.prepare(`INSERT INTO source_cutovers
    (device_id, provider, cutover_at, legacy_source, native_source)
    VALUES ('d1', 'claude', ?, 'cc-switch', 'claude-code')`).run(cutover)
  const app = apiRoutes(db)
  const cookie = await adminCookie(app)
  const response = await app.request(`/admin/audit/summary?${isoWindow(cutover)}`, {
    headers: { Cookie: cookie },
  })
  assert.equal(response.status, 200)
  const summary = await response.json() as {
    authoritative: { records: number }; physical: { records: number }; hidden: { records: number }
  }
  assert.deepEqual({
    authoritative: summary.authoritative.records,
    physical: summary.physical.records,
    hidden: summary.hidden.records,
  }, { authoritative: 2, physical: 4, hidden: 2 })
  const physical = await (await app.request(
    `/admin/audit/records?${isoWindow(cutover)}&visibility=physical`,
    { headers: { Cookie: cookie } },
  )).json() as AuditRecordsPage<AuditAdminRecord>
  assert.equal(physical.rows.length, 4)
  assert.equal(physical.rows.filter(row => row.is_authoritative).length, 2)
  const hidden = await (await app.request(
    `/admin/audit/records?${isoWindow(cutover)}&visibility=hidden`,
    { headers: { Cookie: cookie } },
  )).json() as AuditRecordsPage<AuditAdminRecord>
  assert.equal(hidden.rows.length, 2)
  assert.ok(hidden.rows.every(row => !row.is_authoritative))
  db.close()
})

test('Dashboard and audit summary conserve one captured ledger snapshot', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const at = new Date(Date.now() - 60_000).toISOString()
  insertUsage(db, { dedup: 'first', timestamp: at, cost: 1, pricingStatus: 'provided' })
  insertUsage(db, { dedup: 'second', timestamp: at, cost: 2, pricingStatus: 'provided' })
  const app = apiRoutes(db)
  const statsWindow = isoWindow(at)
  const stats = await (await app.request(`/stats?${statsWindow}&timezone_offset=-480`)).json() as {
    snapshot: { since: string; until: string; timezone_offset: number; max_record_id: number }
    totals: { total_calls: number; real_total_tokens: number; total_cost: number }
  }
  insertUsage(db, { dedup: 'concurrent', timestamp: at, cost: 100, pricingStatus: 'provided' })
  const params = new URLSearchParams({
    since: stats.snapshot.since, until: stats.snapshot.until,
    timezone_offset: String(stats.snapshot.timezone_offset),
    snapshot_max_id: String(stats.snapshot.max_record_id),
  })
  const cookie = await adminCookie(app)
  const summary = await (await app.request(`/admin/audit/summary?${params}`, {
    headers: { Cookie: cookie },
  })).json() as { authoritative: { calls: number; real_total_tokens: number; cost_usd: number } }
  assert.equal(summary.authoritative.calls, stats.totals.total_calls)
  assert.equal(summary.authoritative.real_total_tokens, stats.totals.real_total_tokens)
  assert.equal(summary.authoritative.cost_usd, stats.totals.total_cost)
  db.close()
})

test('audit pricing explanation reports exact rules and later drift', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const rule = db.prepare(`INSERT INTO pricing_rules
    (model, mode, input_price, output_price, cache_read_price, cache_write_price)
    VALUES ('priced-model', 'priced', 2, 0, 0, 0)`).run()
  const at = new Date(Date.now() - 60_000).toISOString()
  insertUsage(db, {
    dedup: 'priced', timestamp: at, model: 'priced-model', cost: 2,
    pricingStatus: 'priced', ruleId: Number(rule.lastInsertRowid),
  })
  const app = apiRoutes(db)
  const cookie = await adminCookie(app)
  const getRecord = async () => {
    const response = await app.request(`/admin/audit/records?${isoWindow(at)}`, {
      headers: { Cookie: cookie },
    })
    return (await response.json() as AuditRecordsPage<AuditAdminRecord>).rows[0]
  }
  assert.equal((await getRecord()).pricing_explanation.status, 'exact')
  db.prepare('UPDATE pricing_rules SET input_price = 3 WHERE id = ?').run(rule.lastInsertRowid)
  const drift = await getRecord()
  assert.equal(drift.pricing_explanation.status, 'rule_drift')
  assert.equal(drift.pricing_explanation.recomputed_cost_usd, 3)
  db.close()
})

function insertCollectorRun(
  db: DB,
  id: string,
  finished: string,
  status: 'success' | 'partial',
  counts: { emitted: number; accepted: number | null; unchanged: number | null },
): void {
  db.prepare(`INSERT INTO collector_runs
    (run_id, device_id, report_schema_version, collector_kind, collector_version,
     schedule_interval_minutes, started_at, finished_at, status, duration_ms,
     emitted, accepted, unchanged)
    VALUES (?, 'd1', 1, 'native', '0.1.0', 30, ?, ?, ?, 1000, ?, ?, ?)`
  ).run(id, new Date(Date.parse(finished) - 1_000).toISOString(), finished,
    status, counts.emitted, counts.accepted, counts.unchanged)
  db.prepare(`INSERT INTO collector_source_runs
    (run_id, source, status, discovered, scanned, emitted, accepted, unchanged,
     watermark_at, last_usage_at, duration_ms)
    VALUES (?, 'codex', ?, 1, 1, ?, ?, ?, ?, ?, 900)`
  ).run(id, status === 'success' ? 'success' : 'upload_failed', counts.emitted,
    counts.accepted, counts.unchanged, finished, finished)
}

test('reconciliation keeps pipeline effects separate from ledger rows', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const at = new Date(Date.now() - 60_000).toISOString()
  insertUsage(db, { dedup: 'ledger', timestamp: at, provider: 'codex', source: 'codex' })
  insertCollectorRun(db, 'run-known', at, 'success', { emitted: 2, accepted: 1, unchanged: 1 })
  insertCollectorRun(db, 'run-unknown', new Date(Date.parse(at) + 1_000).toISOString(),
    'partial', { emitted: 1, accepted: null, unchanged: null })
  db.prepare(`UPDATE collector_telemetry_maintenance
    SET coverage_since = ? WHERE id = 1`).run(at)
  const app = apiRoutes(db)
  const cookie = await adminCookie(app)
  const response = await app.request(
    `/admin/audit/reconciliation?${isoWindow(at)}&provider=codex`,
    { headers: { Cookie: cookie } },
  )
  assert.equal(response.status, 200)
  const body = await response.json() as {
    telemetry_coverage: {
      coverage_since: string | null
      earliest_retained_at: string | null
      latest_retained_at: string | null
      truncated: boolean
    }
    rows: Array<{
      emitted: number; accepted: number; unchanged: number
      unknown_acknowledgements: number; pipeline_balance: number
      ledger: { records: number }
    }>
  }
  assert.equal(body.rows[0].emitted, 3)
  assert.equal(body.rows[0].accepted, 1)
  assert.equal(body.rows[0].unchanged, 1)
  assert.equal(body.rows[0].unknown_acknowledgements, 1)
  assert.equal(body.rows[0].pipeline_balance, 0)
  assert.equal(body.rows[0].ledger.records, 1)
  assert.deepEqual(body.telemetry_coverage, {
    coverage_since: at,
    earliest_retained_at: at,
    latest_retained_at: new Date(Date.parse(at) + 1_000).toISOString(),
    truncated: true,
  })
  db.close()
})

test('admin audit endpoints require auth and exports stream safe CSV and JSON', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const at = new Date(Date.now() - 60_000).toISOString()
  insertUsage(db, {
    dedup: '=dedup', timestamp: at, model: '=MODEL', source: 'C:\\Users\\secret\\usage.jsonl',
  })
  const app = apiRoutes(db)
  for (const path of [
    '/admin/audit/records', '/admin/audit/summary', '/admin/audit/reconciliation',
    '/admin/audit/cutover-events', '/admin/audit/export?format=json',
  ]) assert.equal((await app.request(path)).status, 401)

  const cookie = await adminCookie(app)
  const json = await app.request(`/admin/audit/export?format=json&${isoWindow(at)}`, {
    headers: { Cookie: cookie },
  })
  assert.equal(json.status, 200)
  const records = await json.json() as AuditAdminRecord[]
  assert.equal(records[0].source_file, '[redacted-local-path]')
  const csv = await app.request(`/admin/audit/export?format=csv&${isoWindow(at)}`, {
    headers: { Cookie: cookie },
  })
  const csvBody = await csv.text()
  assert.match(csvBody, /pricing_explanation_status/)
  assert.match(csvBody, /"'=MODEL"/)
  assert.doesNotMatch(csvBody, /Users\\secret/)

  const originalPrepare = db.prepare.bind(db)
  let usedAllForExport = false
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql)
    if (!sql.includes('ORDER BY u.timestamp DESC, u.id DESC')) return statement
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === 'all') return () => { usedAllForExport = true; throw new Error('all forbidden') }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }) as DB['prepare']
  const exported = getAuditExport(db, Object.fromEntries(new URLSearchParams(isoWindow(at))))
  assert.equal(Array.isArray(exported.rows), false)
  assert.equal(typeof exported.rows.next, 'function')
  assert.equal([...exported.rows].length, 1)
  assert.equal(usedAllForExport, false)
  db.close()
})

test('cutover event cursor stays stable when newer events arrive', async () => {
  const db = initDB(':memory:')
  insertDevice(db)
  const insert = db.prepare(`INSERT INTO source_cutover_events
    (device_id, provider, previous_cutover_at, cutover_at, actor, reason)
    VALUES ('d1', 'codex', NULL, NULL, 'admin', ?)`)
  for (const reason of ['one', 'two', 'three']) insert.run(reason)
  const app = apiRoutes(db)
  const cookie = await adminCookie(app)
  const first = await (await app.request('/admin/audit/cutover-events?limit=2', {
    headers: { Cookie: cookie },
  })).json() as { rows: Array<{ id: number }>; next_cursor: string }
  insert.run('newer')
  const second = await (await app.request(
    `/admin/audit/cutover-events?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
    { headers: { Cookie: cookie } },
  )).json() as { rows: Array<{ id: number }> }
  assert.deepEqual([...first.rows, ...second.rows].map(row => row.id), [3, 2, 1])
  db.close()
})
