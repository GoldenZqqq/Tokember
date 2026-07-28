import assert from 'node:assert/strict'
import test from 'node:test'
import { initDB } from './db.js'
import { apiRoutes } from './routes.js'

process.env.TOKEMBER_ADMIN_PASSWORD = 'development'
delete process.env.TOKEMBER_API_KEY
delete process.env.AI_BURN_API_KEY
delete process.env.API_KEY

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie')
  assert.ok(header)
  return header.split(';')[0]
}

function collectorRunBody(deviceId = 'd1', finished = new Date()): Record<string, unknown> {
  const started = new Date(finished.getTime() - 1_000)
  return {
    schema_version: 1, run_id: `run-${deviceId}-${finished.getTime()}`, device_id: deviceId,
    collector_kind: 'native', collector_version: '0.1.0', schedule_interval_minutes: 30,
    started_at: started.toISOString(), finished_at: finished.toISOString(),
    status: 'success', duration_ms: 1_000, emitted: 0, accepted: 0, unchanged: 0,
    error_summary: null,
    sources: [{
      source: 'codex', status: 'success', discovered: 2, scanned: 1,
      emitted: 0, accepted: 0, unchanged: 0,
      watermark_at: finished.toISOString(), last_usage_at: null,
      duration_ms: 900, error_summary: null,
    }],
  }
}

test('protects admin routes and accepts the configured password', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)

  const denied = await app.request('/admin/pricing/rules')
  assert.equal(denied.status, 401)

  const badLogin = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  })
  assert.equal(badLogin.status, 401)

  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  assert.equal(login.status, 200)
  const rules = await app.request('/admin/pricing/rules', {
    headers: { Cookie: cookieFrom(login) },
  })
  assert.equal(rules.status, 200)
  db.close()
})

test('prices newly ingested usage with an admin-created rule', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)
  const created = await app.request('/admin/pricing/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source: null, model: 'model-a', mode: 'priced',
      input_price: 2, output_price: 8, cache_read_price: 0.2,
      cache_write_price: 3, enabled: true,
    }),
  })
  assert.equal(created.status, 201)

  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  const ingested = await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1', records: [{
        provider: 'hermes', model: 'model-a', input_tokens: 1_000_000,
        output_tokens: 100_000, cache_read_tokens: 500_000,
        cache_creation_tokens: 20_000, timestamp: new Date().toISOString(),
        dedup_key: 'priced-1',
      }],
    }),
  })
  assert.equal(ingested.status, 200)
  const row = db.prepare(`
    SELECT cost_usd, pricing_status FROM usage_records WHERE dedup_key = 'priced-1'
  `).get() as { cost_usd: number; pricing_status: string }
  assert.equal(row.cost_usd, 2.96)
  assert.equal(row.pricing_status, 'priced')
  db.close()
})

test('allows one global rule and distinct source overrides per model', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)
  const create = (source: string | null) => app.request('/admin/pricing/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source, model: 'model-a', mode: 'priced', input_price: 1,
      output_price: 2, cache_read_price: 0.1, cache_write_price: 0, enabled: true,
    }),
  })

  assert.equal((await create(null)).status, 201)
  assert.equal((await create('hermes')).status, 201)
  assert.equal((await create('codex')).status, 201)
  assert.equal((await create(null)).status, 409)
  assert.equal((await create('hermes')).status, 409)
  db.close()
})

test('rejects Sub2API devices and usage from the activity ledger', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const deniedDevice = await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'sub2api-key-1', name: 'Sub2API-test' }),
  })
  assert.equal(deniedDevice.status, 410)
  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  const deniedUsage = await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1', records: [{
        provider: 'sub2api', model: 'free-model', input_tokens: 100,
        output_tokens: 10, cost_usd: 0, cost_provided: true,
        timestamp: '2026-07-14T00:00:00.000Z', dedup_key: 'provided-zero-1',
      }],
    }),
  })
  assert.equal(deniedUsage.status, 410)
  const count = db.prepare('SELECT COUNT(*) AS count FROM usage_records')
    .get() as { count: number }
  assert.equal(count.count, 0)
  db.close()
})

test('classifies an unpriced model as a source-scoped alias and reuses it on ingest', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)
  const createRule = async (model: string) => {
    const response = await app.request('/admin/pricing/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        source: null, model, mode: 'priced', input_price: 2,
        output_price: 8, cache_read_price: 0, cache_write_price: 0, enabled: true,
      }),
    })
    return (await response.json() as { rule: { id: number } }).rule.id
  }
  const ruleId = await createRule('anthropic/claude-sonnet-4.6')
  const otherRuleId = await createRule('other-model')
  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  const ingest = (
    provider: string,
    dedupKey: string,
    cost?: { cost_usd: number; cost_provided: true },
  ) => app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1', records: [{
        provider, model: 'claude-4.6-sonnect', input_tokens: 1_000_000,
        output_tokens: 100_000, timestamp: '2026-07-16T00:00:00.000Z',
        dedup_key: dedupKey, ...cost,
      }],
    }),
  })
  await ingest('claude', 'alias-before')
  await ingest('claude', 'alias-provided', { cost_usd: 9, cost_provided: true })

  const classified = await app.request('/admin/maintenance/classify-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source: 'claude', alias: 'claude-4.6-sonnect', pricing_rule_id: ruleId,
    }),
  })
  assert.equal(classified.status, 200)
  const result = await classified.json() as {
    affected: number; repriced: number; cost_delta: number; model: string
  }
  assert.deepEqual(result, {
    affected: 2, repriced: 1, cost_delta: 2.8,
    source: 'claude', alias: 'claude-4.6-sonnect',
    model: 'anthropic/claude-sonnet-4.6',
  })

  await ingest('claude', 'alias-after')
  await ingest('hermes', 'alias-other-source')
  const rows = db.prepare(`
    SELECT dedup_key, model, pricing_status, cost_usd
    FROM usage_records ORDER BY dedup_key
  `).all()
  assert.deepEqual(rows, [
    { dedup_key: 'alias-after', model: 'anthropic/claude-sonnet-4.6', pricing_status: 'priced', cost_usd: 2.8 },
    { dedup_key: 'alias-before', model: 'anthropic/claude-sonnet-4.6', pricing_status: 'priced', cost_usd: 2.8 },
    { dedup_key: 'alias-other-source', model: 'claude-4.6-sonnect', pricing_status: 'unpriced', cost_usd: 0 },
    { dedup_key: 'alias-provided', model: 'anthropic/claude-sonnet-4.6', pricing_status: 'provided', cost_usd: 9 },
  ])

  const rules = await (await app.request('/admin/pricing/rules', {
    headers: { Cookie: cookie },
  })).json() as { rules: { id: number; aliases: { source: string; alias: string }[] }[] }
  assert.deepEqual(
    rules.rules.find(rule => rule.id === ruleId)?.aliases
      .map(alias => ({ source: alias.source, alias: alias.alias })),
    [{ source: 'claude', alias: 'claude-4.6-sonnect' }],
  )

  const conflict = await app.request(`/admin/pricing/rules/${otherRuleId}/aliases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ source: 'claude', alias: 'claude-4.6-sonnect' }),
  })
  assert.equal(conflict.status, 409)

  const deleted = await app.request(`/admin/pricing/rules/${ruleId}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  })
  assert.equal(deleted.status, 200)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM model_aliases').get() as { count: number }).count, 0)
  db.close()
})

test('records a device heartbeat and rotates the previous seen time', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)

  async function register() {
    await app.request('/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'd1', name: 'Device' }),
    })
    return db.prepare(
      'SELECT last_seen_at, prev_seen_at FROM devices WHERE id = ?'
    ).get('d1') as { last_seen_at: string | null; prev_seen_at: string | null }
  }

  const first = await register()
  assert.ok(first.last_seen_at, 'first heartbeat sets last_seen_at')
  assert.equal(first.prev_seen_at, null, 'no previous heartbeat yet')

  const second = await register()
  assert.equal(second.prev_seen_at, first.last_seen_at, 'previous rotates into prev_seen_at')
  assert.ok(second.last_seen_at! >= first.last_seen_at!, 'last_seen_at moves forward')
  db.close()
})

test('exposes device summaries with heartbeat and record stats to admins', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)

  const denied = await app.request('/admin/devices')
  assert.equal(denied.status, 401)

  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)

  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1', records: [{
        provider: 'hermes', model: 'model-a', timestamp: '2026-07-12T00:00:00.000Z',
        dedup_key: 'dev-1',
      }],
    }),
  })
  const run = await app.request('/collector-runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectorRunBody()),
  })
  assert.equal(run.status, 200)

  const response = await app.request('/admin/devices', { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  const { devices } = await response.json() as {
    devices: {
      id: string
      record_count: number
      last_record_at: string | null
      last_seen_at: string | null
      collector: {
        status: string
        freshness_threshold_minutes: number
        last_successful_at: string
        sources: { source: string; discovered: number; scanned: number }[]
      }
    }[]
  }
  assert.equal(devices.length, 1)
  assert.equal(devices[0].id, 'd1')
  assert.equal(devices[0].record_count, 1)
  assert.equal(devices[0].last_record_at, '2026-07-12T00:00:00.000Z')
  assert.ok(devices[0].last_seen_at, 'device carries a heartbeat')
  assert.equal(devices[0].collector.status, 'healthy')
  assert.equal(devices[0].collector.freshness_threshold_minutes, 75)
  assert.ok(devices[0].collector.last_successful_at)
  assert.deepEqual(devices[0].collector.sources.map(source => ({
    source: source.source, discovered: source.discovered, scanned: source.scanned,
  })), [{ source: 'codex', discovered: 2, scanned: 1 }])
  db.close()
})

test('rejects collector write endpoints without the configured API key', async () => {
  const previous = process.env.TOKEMBER_API_KEY
  process.env.TOKEMBER_API_KEY = 'secret-write-key'
  try {
    const db = initDB(':memory:')
    const app = apiRoutes(db)

    const deniedDevice = await app.request('/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'd1', name: 'Device' }),
    })
    assert.equal(deniedDevice.status, 401)

    const deniedIngest = await app.request('/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'd1', records: [] }),
    })
    assert.equal(deniedIngest.status, 401)
    const deniedCutover = await app.request('/source-cutovers?device_id=d1&provider=claude')
    assert.equal(deniedCutover.status, 401)

    const okDevice = await app.request('/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-write-key',
      },
      body: JSON.stringify({ id: 'd1', name: 'Device' }),
    })
    assert.equal(okDevice.status, 200)

    const okIngest = await app.request('/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'secret-write-key',
      },
      body: JSON.stringify({
        device_id: 'd1',
        records: [{
          provider: 'hermes', model: 'model-a', input_tokens: 0, output_tokens: 0,
          timestamp: new Date().toISOString(), dedup_key: 'auth-1',
        }],
      }),
    })
    assert.equal(okIngest.status, 200)

    const okCutover = await app.request('/source-cutovers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-write-key',
      },
      body: JSON.stringify({
        device_id: 'd1', provider: 'claude', cutover_at: '1970-01-01T00:00:00.000Z',
      }),
    })
    assert.equal(okCutover.status, 200)

    const publicDevices = await app.request('/devices')
    assert.equal(publicDevices.status, 200)
    db.close()
  } finally {
    if (previous === undefined) delete process.env.TOKEMBER_API_KEY
    else process.env.TOKEMBER_API_KEY = previous
  }
})

test('maintenance ignore removes placeholders from unpriced and reprice', async () => {
  process.env.TOKEMBER_ADMIN_PASSWORD = 'development'
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)

  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1',
      records: [
        {
          provider: 'antigravity', model: 'MODEL_PLACEHOLDER_1',
          input_tokens: 100, output_tokens: 10,
          timestamp: '2026-07-14T00:00:00.000Z', dedup_key: 'ph-1',
        },
        {
          provider: 'hermes', model: 'real-model',
          input_tokens: 1_000_000, output_tokens: 0,
          timestamp: '2026-07-14T00:00:00.000Z', dedup_key: 'real-1',
        },
      ],
    }),
  })

  // Create a global rule so reprice can match real-model only.
  await app.request('/admin/pricing/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source: null, model: 'real-model', mode: 'priced',
      input_price: 1, output_price: 0, cache_read_price: 0, cache_write_price: 0, enabled: true,
    }),
  })

  const summaryBefore = await app.request('/admin/maintenance/summary', {
    headers: { Cookie: cookie },
  })
  assert.equal(summaryBefore.status, 200)
  const before = await summaryBefore.json() as {
    unpriced_count: number
    placeholder_unpriced_count: number
    reprice: { matched: number; cost_delta: number; applied: boolean }
  }
  assert.equal(before.unpriced_count, 2)
  assert.equal(before.placeholder_unpriced_count, 1)
  assert.equal(before.reprice.matched, 1)
  assert.equal(before.reprice.applied, false)

  const ignored = await app.request('/admin/maintenance/ignore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  })
  assert.equal(ignored.status, 200)
  const ignoredBody = await ignored.json() as { affected: number }
  assert.equal(ignoredBody.affected, 1)

  const summaryAfter = await (await app.request('/admin/maintenance/summary', {
    headers: { Cookie: cookie },
  })).json() as {
    unpriced_count: number
    ignored_count: number
    placeholder_unpriced_count: number
    reprice: { matched: number }
  }
  assert.equal(summaryAfter.unpriced_count, 1)
  assert.equal(summaryAfter.ignored_count, 1)
  assert.equal(summaryAfter.placeholder_unpriced_count, 0)
  assert.equal(summaryAfter.reprice.matched, 1)

  const row = db.prepare(`
    SELECT pricing_status FROM usage_records WHERE dedup_key = 'ph-1'
  `).get() as { pricing_status: string }
  assert.equal(row.pricing_status, 'ignored')
  db.close()
})

test('maintenance restore returns ignored placeholders to unpriced', async () => {
  process.env.TOKEMBER_ADMIN_PASSWORD = 'development'
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)
  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1',
      records: [{
        provider: 'antigravity', model: 'MODEL_PLACEHOLDER_xyz',
        input_tokens: 10, output_tokens: 1,
        timestamp: '2026-07-14T00:00:00.000Z', dedup_key: 'ph-2',
      }],
    }),
  })

  await app.request('/admin/maintenance/ignore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  })
  const restored = await app.request('/admin/maintenance/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  })
  assert.equal(restored.status, 200)
  const body = await restored.json() as { affected: number }
  assert.equal(body.affected, 1)
  const status = db.prepare(`
    SELECT pricing_status FROM usage_records WHERE dedup_key = 'ph-2'
  `).get() as { pricing_status: string }
  assert.equal(status.pricing_status, 'unpriced')
  db.close()
})

test('exposes redacted system info to admins only', async () => {
  process.env.TOKEMBER_ADMIN_PASSWORD = 'development'
  const db = initDB(':memory:')
  const app = apiRoutes(db, '/opt/tokember/data/tokember.db')

  const denied = await app.request('/admin/system')
  assert.equal(denied.status, 401)

  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)
  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  const run = await app.request('/collector-runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectorRunBody()),
  })
  assert.equal(run.status, 200)

  const response = await app.request('/admin/system', { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  const body = await response.json() as {
    version: string
    build: { release_id: string; commit: string; lockfile_sha256: string; architecture: string }
    runtime_node_version: string
    runtime_architecture: string
    db_path: string
    db_ok: boolean
    counts: { devices: number; usage_records: number; pricing_rules: number }
    health: { status: string; online_devices: number }
    devices: {
      last_successful_run_at: string | null
      collector_status: string
      schedule_interval_minutes: number | null
      online: boolean
    }[]
  }
  assert.equal(body.db_ok, true)
  assert.equal(body.db_path, 'data/tokember.db')
  assert.ok(!body.db_path.includes('/opt/'))
  assert.equal(body.counts.devices, 1)
  assert.equal(typeof body.version, 'string')
  assert.equal(typeof body.build.release_id, 'string')
  assert.equal(typeof body.build.commit, 'string')
  assert.equal(typeof body.build.lockfile_sha256, 'string')
  assert.equal(typeof body.build.architecture, 'string')
  assert.match(body.runtime_node_version, /^\d+\./)
  assert.equal(body.runtime_architecture, process.arch)
  assert.equal(body.devices[0].collector_status, 'healthy')
  assert.equal(body.devices[0].schedule_interval_minutes, 30)
  assert.ok(body.devices[0].last_successful_run_at)
  assert.equal(body.devices[0].online, true)
  assert.equal(body.health.online_devices, 1)
  assert.ok(['ok', 'degraded', 'error'].includes(body.health.status))
  db.close()
})

test('source cutover registration is explicit, idempotent and immutable for collectors', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const timestamp = new Date(Date.now() - 60_000).toISOString()

  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'd1', records: [{
      provider: 'claude', model: 'model-a', timestamp,
      source_file: 'cc-switch', dedup_key: 'ccsw:a',
    }] }),
  })

  const registered = await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device', native_sources: ['claude', 'codex'] }),
  })
  assert.equal(registered.status, 200)
  const registration = await registered.json() as any
  assert.equal(registration.source_authority.claude.legacy_history, true)
  assert.equal(registration.source_authority.claude.cutover_at, null)
  assert.equal(registration.source_authority.codex.legacy_history, false)

  const cutoverAt = new Date().toISOString()
  const payload = { device_id: 'd1', provider: 'claude', cutover_at: cutoverAt }
  const created = await app.request('/source-cutovers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal(created.status, 200)
  assert.equal((await created.json() as any).created, true)
  const repeated = await app.request('/source-cutovers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json() as any).created, false)
  const moved = await app.request('/source-cutovers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, cutover_at: new Date(Date.now() + 1_000).toISOString() }),
  })
  assert.equal(moved.status, 409)
  assert.equal((db.prepare('SELECT COUNT(*) count FROM source_cutover_events').get() as any).count, 1)
  db.close()
})

test('admins can audit and roll back a committed source cutover', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  const cutoverAt = new Date().toISOString()
  await app.request('/source-cutovers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'd1', provider: 'claude', cutover_at: cutoverAt }),
  })
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)
  const listed = await app.request('/admin/source-cutovers', { headers: { Cookie: cookie } })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json() as any).cutovers.length, 1)
  const rolledBack = await app.request('/admin/source-cutovers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      device_id: 'd1', provider: 'claude', cutover_at: null,
      reason: 'rollback after migration verification',
    }),
  })
  assert.equal(rolledBack.status, 200)
  assert.equal((db.prepare('SELECT COUNT(*) count FROM source_cutovers').get() as any).count, 0)
  const events = db.prepare('SELECT actor FROM source_cutover_events ORDER BY id').all() as any[]
  assert.deepEqual(events.map(event => event.actor), ['collector', 'admin'])
  db.close()
})

test('stats and records switch authority at each device/provider cutover', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const cutoverAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
  const before = new Date(Date.parse(cutoverAt) - 60_000).toISOString()
  const after = new Date(Date.parse(cutoverAt) + 60_000).toISOString()

  for (const [id, name] of [['d1', 'Migrated'], ['d2', 'Native']]) {
    await app.request('/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    })
  }

  const records = [
    ['claude', before, 'cc-switch', 'ccsw:claude-before'],
    ['claude', after, 'cc-switch', 'ccsw:claude-after'],
    ['claude', before, 'claude-code', 'claude:before'],
    ['claude', after, 'claude-code', 'claude:after'],
    ['codex', after, 'cc-switch', 'ccsw:codex-after'],
    ['codex', after, 'codex', 'codex:after'],
  ].map(([provider, recordTimestamp, sourceFile, dedupKey]) => ({
    provider, model: 'model', input_tokens: 10, output_tokens: 1,
    cache_read_tokens: dedupKey === 'claude:after' ? 20 : 0,
    cache_creation_tokens: dedupKey === 'claude:after' ? 30 : 0,
    timestamp: recordTimestamp, source_file: sourceFile, dedup_key: dedupKey,
  }))
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'd1', records }),
  })
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'd2', records: [{
      provider: 'codex', model: 'model', input_tokens: 10, output_tokens: 1,
      timestamp: after, source_file: 'codex', dedup_key: 'codex:native-only',
    }] }),
  })
  await app.request('/source-cutovers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'd1', provider: 'claude', cutover_at: cutoverAt }),
  })

  const body = await (await app.request('/stats?days=0')).json() as any
  assert.equal(body.totals.total_calls, 4)
  assert.equal(body.totals.real_total_tokens, 94)
  assert.equal(
    body.daily.reduce((sum: number, row: any) => sum + row.real_total_tokens, 0),
    body.totals.real_total_tokens,
  )
  const today = await (await app.request('/stats?range=today')).json() as any
  assert.equal(today.daily.length, 24)
  assert.ok(today.daily.every((row: any) => Number.isFinite(row.real_total_tokens)))
  assert.deepEqual(
    body.byProvider.map((row: any) => [row.provider, row.calls]).sort(),
    [['claude', 2], ['codex', 2]],
  )
  const raw = await (await app.request('/records?limit=20')).json() as any
  assert.equal(raw.rows.length, 4)
  assert.ok(raw.rows.every((row: any) => !('dedup_key' in row) && !('source_file' in row)))
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const audit = await (await app.request('/admin/audit/records?limit=20', {
    headers: { Cookie: cookieFrom(login) },
  })).json() as any
  assert.deepEqual(audit.rows.map((row: any) => row.dedup_key).sort(), [
    'ccsw:claude-before', 'ccsw:codex-after', 'claude:after', 'codex:native-only',
  ])
  const year = new Date().getFullYear()
  const yearly = await (await app.request(`/stats/year?year=${year}`)).json() as any
  assert.equal(yearly.totals.total_calls, 4)
  const stored = db.prepare('SELECT COUNT(*) AS count FROM usage_records').get() as { count: number }
  assert.equal(stored.count, 7)
  db.close()
})

test('Antigravity native history starts after the last CodeBurn-derived row', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const legacyEnd = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
  const before = new Date(Date.parse(legacyEnd) - 60_000).toISOString()
  const after = new Date(Date.parse(legacyEnd) + 60_000).toISOString()

  for (const id of ['legacy-device', 'native-device']) {
    await app.request('/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: id }),
    })
  }
  const records = [
    [before, 'legacy-cascade', 'cb:old'],
    [legacyEnd, 'legacy-cascade', 'cb:latest'],
    [before, 'native-cascade', 'antigravity:overlap'],
    [legacyEnd, 'native-cascade', 'antigravity:boundary'],
    [after, 'native-cascade', 'antigravity:new'],
  ].map(([timestamp, sourceFile, dedupKey]) => ({
    provider: 'antigravity', model: 'model', input_tokens: 10, output_tokens: 1,
    timestamp, source_file: sourceFile, dedup_key: dedupKey,
  }))
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'legacy-device', records }),
  })
  await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'native-device', records: [{
      provider: 'antigravity', model: 'model', input_tokens: 10, output_tokens: 1,
      timestamp: before, source_file: 'native-cascade', dedup_key: 'antigravity:native-only',
    }] }),
  })

  const stats = await (await app.request('/stats?days=0')).json() as any
  assert.equal(stats.byProvider.find((row: any) => row.provider === 'antigravity').calls, 4)
  const raw = await (await app.request('/records?provider=antigravity&limit=20')).json() as any
  assert.equal(raw.rows.length, 4)
  assert.ok(raw.rows.every((row: any) => !('dedup_key' in row) && !('source_file' in row)))
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const audit = await (await app.request(
    '/admin/audit/records?provider=antigravity&limit=20',
    { headers: { Cookie: cookieFrom(login) } },
  )).json() as any
  assert.deepEqual(audit.rows.map((row: any) => row.dedup_key).sort(), [
    'antigravity:native-only', 'antigravity:new', 'cb:latest', 'cb:old',
  ])
  const year = new Date().getFullYear()
  const yearly = await (await app.request(`/stats/year?year=${year}`)).json() as any
  assert.equal(yearly.totals.total_calls, 4)
  const stored = db.prepare('SELECT COUNT(*) count FROM usage_records').get() as { count: number }
  assert.equal(stored.count, 6)
  db.close()
})

test('editing a rule marks it user-modified so catalog updates stop touching it', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const cookie = cookieFrom(login)

  const listed = await (await app.request('/admin/pricing/rules', {
    headers: { Cookie: cookie },
  })).json() as any
  const builtin = listed.rules.find((rule: any) => rule.model === 'claude-opus-5')
  assert.equal(builtin.origin, 'builtin')
  assert.equal(builtin.user_modified, 0)

  // A gateway deployment lowers the price; upgrades must respect that.
  const edited = await app.request(`/admin/pricing/rules/${builtin.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source: null, model: 'claude-opus-5', mode: 'priced',
      input_price: 1, output_price: 2, cache_read_price: 0, cache_write_price: 0,
      enabled: 1,
      // The server owns these two; a client must not be able to set them.
      origin: 'builtin', user_modified: 0,
    }),
  })
  assert.equal(edited.status, 200)
  const updated = (await edited.json() as any).rule
  assert.equal(updated.user_modified, 1)
  assert.equal(updated.input_price, 1)

  const created = await app.request('/admin/pricing/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source: null, model: 'operator-model', mode: 'priced',
      input_price: 9, output_price: 9, cache_read_price: 0, cache_write_price: 0,
      enabled: 1, origin: 'builtin', user_modified: 0,
    }),
  })
  assert.equal(created.status, 201)
  // A rule the operator created is user-owned regardless of the payload.
  assert.equal((await created.json() as any).rule.origin, 'user')
  db.close()
})
