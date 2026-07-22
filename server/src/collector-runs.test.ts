import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectorRunReport } from '@tokember/contracts/collector-observability'
import { initDB } from './db.js'
import {
  COLLECTOR_RUN_MAX_BODY_BYTES,
  CollectorRunRequestError,
  decodeCollectorRunReport,
  sanitizeCollectorError,
  upsertCollectorRun,
} from './collector-runs.js'
import { apiRoutes } from './routes.js'
import {
  collectorFreshnessThresholdMs,
  getCollectorHealthMap,
} from './collector-health.js'
import {
  getCollectorTelemetryCoverage,
  maintainCollectorTelemetry,
} from './collector-retention.js'

function validSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'codex', status: 'success', discovered: 4, scanned: 3,
    emitted: 2, accepted: 1, unchanged: 1,
    watermark_at: '2026-07-16T23:59:59.000Z',
    last_usage_at: '2026-07-16T23:59:59.000Z',
    duration_ms: 900, error_summary: null,
    ...overrides,
  }
}

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: 'run:test-1',
    device_id: 'd1',
    collector_kind: 'native',
    collector_version: '0.1.0',
    schedule_interval_minutes: 30,
    started_at: '2026-07-17T00:00:00.000Z',
    finished_at: '2026-07-17T00:00:01.000Z',
    status: 'success',
    duration_ms: 1000,
    emitted: 2,
    accepted: 1,
    unchanged: 1,
    error_summary: null,
    sources: [validSource()],
    ...overrides,
  }
}

function expectDecodeError(body: unknown, code: string): void {
  assert.throws(() => decodeCollectorRunReport(body), (error: unknown) => {
    assert.ok(error instanceof CollectorRunRequestError)
    assert.equal(error.code, code)
    return true
  })
}

test('collector run decoder enforces source rollups and final status', () => {
  const decoded = decodeCollectorRunReport(validReport())
  assert.equal(decoded.started_at, '2026-07-17T00:00:00.000Z')
  expectDecodeError(validReport({ emitted: 3 }), 'invalid_source_rollup')
  expectDecodeError(validReport({ status: 'failed' }), 'invalid_run_status')
  expectDecodeError(validReport({
    sources: [validSource(), validSource()],
  }), 'duplicate_source')
  expectDecodeError(validReport({
    sources: [validSource({
      status: 'upload_failed', accepted: null, unchanged: null, error_summary: null,
    })],
    status: 'failed', accepted: null, unchanged: null,
  }), 'missing_error_summary')
})

test('collector errors redact secrets, user paths and long text', () => {
  const value = sanitizeCollectorError(
    'Authorization: Bearer top-secret X-API-Key: other-secret TOKEMBER_API_KEY="abc value" '
    + 'TOKEMBER_DEVICE_TOKEN=tkdc_abcdefghijkl_abcdefghijklmnopqrstuvwxyz123456 '
    + 'C:\\Users\\Alice\\private\\session.json /home/bob/.claude/session.json '
    + 'x'.repeat(800),
  )!
  assert.doesNotMatch(value, /top-secret|other-secret|abc|value|Alice|bob|session\.json|tkdc_/)
  assert.match(value, /\[redacted\]|\[path\]/)
  assert.ok(value.length <= 500)
})

test('collector run upsert is idempotent and preserves device ownership', () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?), (?, ?)')
    .run('d1', 'One', 'd2', 'Two')
  const report = decodeCollectorRunReport(validReport())
  assert.equal(upsertCollectorRun(db, report), 'created')
  const updated = { ...report, duration_ms: 1200, sources: [{ ...report.sources[0], duration_ms: 1100 }] }
  assert.equal(upsertCollectorRun(db, updated), 'updated')
  assert.equal((db.prepare('SELECT duration_ms FROM collector_runs WHERE run_id = ?')
    .get(report.run_id) as { duration_ms: number }).duration_ms, 1200)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM collector_source_runs')
    .get() as { count: number }).count, 1)
  assert.equal(upsertCollectorRun(db, { ...report, device_id: 'd2' }), 'device-conflict')
  db.close()
})

test('collector telemetry retention prunes detail but preserves health anchors and usage', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO devices (id, name) VALUES ('d1', 'One')").run()
  // Suppress upsert's real-clock maintenance until this test invokes it with a fixed clock.
  db.prepare(`UPDATE collector_telemetry_maintenance
    SET last_attempted_at = '2999-01-01T00:00:00.000Z' WHERE id = 1`).run()
  const reports = [
    validReport({
      run_id: 'old-prunable', started_at: '2025-12-31T23:59:00.000Z',
      finished_at: '2026-01-01T00:00:00.000Z',
      sources: [validSource({
        watermark_at: '2026-01-01T00:00:00.000Z',
        last_usage_at: '2026-01-01T00:00:00.000Z',
      })],
    }),
    validReport({
      run_id: 'old-success-anchor', started_at: '2026-01-01T23:59:00.000Z',
      finished_at: '2026-01-02T00:00:00.000Z',
      sources: [validSource({
        watermark_at: '2026-01-02T00:00:00.000Z',
        last_usage_at: '2026-01-02T00:00:00.000Z',
      })],
    }),
    ...['03', '04'].map(day => validReport({
      run_id: `old-failure-${day}`,
      started_at: `2026-01-${day}T00:00:00.000Z`,
      finished_at: `2026-01-${day}T00:01:00.000Z`,
      status: 'failed', emitted: 0, accepted: null, unchanged: null,
      error_summary: 'network failed',
      sources: [validSource({
        status: 'upload_failed', emitted: 0, accepted: null, unchanged: null,
        watermark_at: null, last_usage_at: null, error_summary: 'network failed',
      })],
    })),
  ].map(decodeCollectorRunReport)
  for (const report of reports) upsertCollectorRun(db, report)
  db.prepare(`INSERT INTO usage_records
    (device_id, provider, model, timestamp, dedup_key)
    VALUES ('d1', 'codex', 'gpt', '2026-01-01T00:00:00.000Z', 'keep-usage')`).run()
  const before = getCollectorHealthMap(db, Date.parse('2026-07-21T00:00:00.000Z')).get('d1')!
  db.prepare('UPDATE collector_telemetry_maintenance SET last_attempted_at = NULL WHERE id = 1').run()

  maintainCollectorTelemetry(db, new Date('2026-07-21T00:00:00.000Z'))

  assert.deepEqual(db.prepare('SELECT run_id FROM collector_runs ORDER BY run_id').all(), [
    { run_id: 'old-failure-03' },
    { run_id: 'old-failure-04' },
    { run_id: 'old-success-anchor' },
  ])
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_records').get() as { count: number }).count, 1)
  const after = getCollectorHealthMap(db, Date.parse('2026-07-21T00:00:00.000Z')).get('d1')!
  assert.equal(after.latest_run?.run_id, before.latest_run?.run_id)
  assert.equal(after.last_successful_at, before.last_successful_at)
  assert.equal(after.sources[0].consecutive_failures, 2)
  assert.equal(after.sources[0].watermark_at, '2026-01-02T00:00:00.000Z')
  const cutoff = '2026-04-22T00:00:00.000Z'
  assert.deepEqual(getCollectorTelemetryCoverage(db, {
    source: 'codex', since: '2026-01-01T00:00:00.000Z',
  }), {
    coverage_since: cutoff,
    earliest_retained_at: '2026-01-02T00:00:00.000Z',
    latest_retained_at: '2026-01-04T00:01:00.000Z',
    truncated: true,
  })

  db.prepare(`UPDATE collector_telemetry_maintenance
    SET last_attempted_at = '2999-01-01T00:00:00.000Z' WHERE id = 1`).run()
  const delayed = decodeCollectorRunReport(validReport({
    run_id: 'same-day-prunable', started_at: '2025-12-01T00:00:00.000Z',
    finished_at: '2025-12-01T00:01:00.000Z',
  }))
  upsertCollectorRun(db, delayed)
  upsertCollectorRun(db, decodeCollectorRunReport(validReport({
    run_id: 'same-day-newer', started_at: '2026-07-21T12:00:00.000Z',
    finished_at: '2026-07-21T12:01:00.000Z',
  })))
  db.prepare(`UPDATE collector_telemetry_maintenance
    SET last_attempted_at = '2026-07-21T00:00:00.000Z' WHERE id = 1`).run()
  maintainCollectorTelemetry(db, new Date('2026-07-21T12:00:00.000Z'))
  assert.ok(db.prepare("SELECT 1 FROM collector_runs WHERE run_id = 'same-day-prunable'").get())
  maintainCollectorTelemetry(db, new Date('2026-07-22T00:00:01.000Z'))
  assert.equal(db.prepare("SELECT 1 FROM collector_runs WHERE run_id = 'same-day-prunable'").get(), undefined)
  db.close()
})

test('collector health uses per-device schedule and latest completed status', () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?), (?, ?)')
    .run('windows', 'Windows', 'hermes', 'Hermes')
  const now = Date.parse('2026-07-17T03:00:00.000Z')
  const windows = decodeCollectorRunReport(validReport({
    run_id: 'windows-success', device_id: 'windows',
    started_at: '2026-07-17T02:29:00.000Z',
    finished_at: '2026-07-17T02:30:00.000Z',
  }))
  const failedSource = validSource({
    status: 'collection_failed', emitted: 0, accepted: null, unchanged: null,
    watermark_at: null, last_usage_at: null, error_summary: 'source failed',
  })
  const failed = decodeCollectorRunReport(validReport({
    run_id: 'windows-failed', device_id: 'windows', status: 'failed',
    started_at: '2026-07-17T02:58:00.000Z',
    finished_at: '2026-07-17T02:59:00.000Z', emitted: 0,
    accepted: null, unchanged: null, error_summary: 'run failed',
    sources: [failedSource],
  }))
  const hermes = decodeCollectorRunReport(validReport({
    run_id: 'hermes-success', device_id: 'hermes', collector_kind: 'hermes',
    schedule_interval_minutes: 60,
    started_at: '2026-07-17T00:30:00.000Z',
    finished_at: '2026-07-17T00:31:00.000Z',
  }))
  for (const report of [windows, failed, hermes]) upsertCollectorRun(db, report)

  const health = getCollectorHealthMap(db, now)
  assert.equal(collectorFreshnessThresholdMs(30), 75 * 60_000)
  assert.equal(collectorFreshnessThresholdMs(60), 150 * 60_000)
  assert.equal(health.get('windows')?.status, 'degraded')
  assert.equal(health.get('windows')?.online, true)
  assert.equal(health.get('windows')?.last_successful_at, '2026-07-17T02:30:00.000Z')
  assert.equal(health.get('windows')?.sources[0].consecutive_failures, 1)
  assert.equal(health.get('windows')?.sources[0].watermark_at, '2026-07-16T23:59:59.000Z')
  assert.equal(health.get('windows')?.sources[0].last_usage_at, '2026-07-16T23:59:59.000Z')
  assert.equal(health.get('hermes')?.status, 'healthy')
  assert.equal(getCollectorHealthMap(db, now + 2 * 60_000).get('hermes')?.status, 'offline')
  db.close()
})

test('machine health stays degraded when one tool source is stale', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO devices (id, name) VALUES ('machine', 'Machine')").run()
  const now = Date.parse('2026-07-17T03:00:00.000Z')
  const native = decodeCollectorRunReport(validReport({
    run_id: 'machine-native', device_id: 'machine',
    finished_at: '2026-07-17T02:30:00.000Z',
  }))
  const hermes = decodeCollectorRunReport(validReport({
    run_id: 'machine-hermes', device_id: 'machine', collector_kind: 'hermes',
    schedule_interval_minutes: 60,
    started_at: '2026-07-17T00:28:00.000Z',
    finished_at: '2026-07-17T00:29:00.000Z',
    sources: [validSource({ source: 'hermes' })],
  }))
  upsertCollectorRun(db, native)
  upsertCollectorRun(db, hermes)

  const health = getCollectorHealthMap(db, now).get('machine')!
  assert.equal(health.status, 'degraded')
  assert.equal(health.online, true)
  assert.equal(health.freshness_threshold_minutes, null)
  assert.equal(health.sources.length, 2)
  db.close()
})

test('collector runtime success clears sticky registration failure health', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO devices (id, name) VALUES ('windows', 'Windows')").run()
  const now = Date.parse('2026-07-17T03:00:00.000Z')
  const failedRuntime = decodeCollectorRunReport(validReport({
    run_id: 'windows-register-timeout',
    device_id: 'windows',
    status: 'failed',
    started_at: '2026-07-16T02:00:00.000Z',
    finished_at: '2026-07-16T02:00:30.000Z',
    emitted: 0,
    accepted: null,
    unchanged: null,
    error_summary: 'Server /api/devices request timed out',
    sources: [validSource({
      source: 'collector',
      status: 'collection_failed',
      discovered: 0,
      scanned: 0,
      emitted: 0,
      accepted: null,
      unchanged: null,
      watermark_at: null,
      last_usage_at: null,
      error_summary: 'Server /api/devices request timed out',
    })],
  }))
  const recovered = decodeCollectorRunReport(validReport({
    run_id: 'windows-recovered',
    device_id: 'windows',
    started_at: '2026-07-17T02:29:00.000Z',
    finished_at: '2026-07-17T02:30:00.000Z',
    emitted: 2,
    accepted: 1,
    unchanged: 1,
    sources: [
      validSource(),
      validSource({
        source: 'collector',
        discovered: 0,
        scanned: 0,
        emitted: 0,
        accepted: 0,
        unchanged: 0,
        watermark_at: null,
        last_usage_at: null,
        duration_ms: 0,
      }),
    ],
  }))
  upsertCollectorRun(db, failedRuntime)
  assert.equal(getCollectorHealthMap(db, now).get('windows')?.status, 'offline')
  upsertCollectorRun(db, recovered)
  const health = getCollectorHealthMap(db, now).get('windows')!
  assert.equal(health.status, 'healthy')
  assert.equal(health.online, true)
  const runtime = health.sources.find(source => source.source === 'collector')
  assert.equal(runtime?.status, 'success')
  assert.equal(runtime?.consecutive_failures, 0)
  db.close()
})

test('collector run route requires write auth and returns stable acknowledgement', async () => {
  const previous = process.env.TOKEMBER_API_KEY
  process.env.TOKEMBER_API_KEY = 'secret-write-key'
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret-write-key',
  }
  try {
    const unauthorized = await app.request('/collector-runs', {
      method: 'POST', body: JSON.stringify(validReport()),
    })
    assert.equal(unauthorized.status, 401)
    const oversized = await app.request('/collector-runs', {
      method: 'POST', headers,
      body: JSON.stringify({ ...validReport(), padding: 'x'.repeat(COLLECTOR_RUN_MAX_BODY_BYTES) }),
    })
    assert.equal(oversized.status, 413)
    assert.equal((await oversized.json() as { code: string }).code, 'payload_too_large')
    const registered = await app.request('/devices', {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'd1', name: 'Device', native_sources: [] }),
    })
    assert.equal(registered.status, 200)
    const response = await app.request('/collector-runs', {
      method: 'POST', headers, body: JSON.stringify(validReport()),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, run_id: 'run:test-1', created: true })

    db.prepare(`UPDATE collector_telemetry_maintenance
      SET last_attempted_at = '2026-07-21T00:00:00.000Z' WHERE id = 1`).run()
    const old = await app.request('/collector-runs', {
      method: 'POST', headers, body: JSON.stringify(validReport({
        run_id: 'old-route-run', started_at: '2025-01-01T00:00:00.000Z',
        finished_at: '2025-01-01T00:00:01.000Z',
      })),
    })
    assert.equal(old.status, 200)
    db.exec(`
      CREATE TRIGGER fail_collector_retention BEFORE DELETE ON collector_runs
      BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;
    `)
    db.prepare('UPDATE collector_telemetry_maintenance SET last_attempted_at = NULL WHERE id = 1').run()
    const maintenanceFailure = await app.request('/collector-runs', {
      method: 'POST', headers, body: JSON.stringify(validReport({ run_id: 'new-route-run' })),
    })
    assert.equal(maintenanceFailure.status, 200)
    assert.equal((await maintenanceFailure.json() as { run_id: string }).run_id, 'new-route-run')
  } finally {
    db.close()
    if (previous === undefined) delete process.env.TOKEMBER_API_KEY
    else process.env.TOKEMBER_API_KEY = previous
  }
})
