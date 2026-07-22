import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database as DatabaseType } from 'better-sqlite3'
import { initDB } from './db.js'
import {
  decodeIngestBody,
  INGEST_MAX_BODY_BYTES,
  INGEST_MAX_RECORDS,
  IngestRequestError,
} from './ingest.js'
import { apiRoutes } from './routes.js'

const NOW = new Date('2026-07-17T03:00:00.000Z')

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'hermes',
    model: 'mimo',
    input_tokens: 100,
    output_tokens: 20,
    timestamp: '2026-07-17T02:00:00.000Z',
    dedup_key: 'ingest:1',
    ...overrides,
  }
}

function expectDecodeError(
  body: unknown,
  expected: { code: string; record_index?: number; field?: string },
): void {
  assert.throws(
    () => decodeIngestBody(body, NOW),
    (error: unknown) => {
      assert.ok(error instanceof IngestRequestError)
      assert.equal(error.code, expected.code)
      assert.equal(error.recordIndex, expected.record_index)
      assert.equal(error.field, expected.field)
      return true
    },
  )
}

async function registerDevice(app: ReturnType<typeof apiRoutes>, id = 'd1'): Promise<void> {
  const response = await app.request('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: id }),
  })
  assert.equal(response.status, 200)
}

async function postIngest(
  app: ReturnType<typeof apiRoutes>,
  body: unknown,
): Promise<Response> {
  return app.request('/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function recordCount(db: DatabaseType): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM usage_records')
    .get() as { count: number }).count
}

test('decoder completes legacy omissions and normalizes timezone timestamps', () => {
  const decoded = decodeIngestBody({
    device_id: ' d1 ',
    records: [validRecord({ timestamp: '2026-07-17T10:00:00+08:00' })],
  }, NOW)
  assert.equal(decoded.device_id, 'd1')
  assert.deepEqual(decoded.records[0], {
    provider: 'hermes', model: 'mimo', request_count: 1,
    input_tokens: 100, output_tokens: 20, cache_read_tokens: 0,
    cache_creation_tokens: 0, reasoning_tokens: 0,
    input_includes_cache_read: false,
    input_includes_cache_creation: false,
    output_includes_reasoning: false,
    cost_usd: 0, cost_provided: false,
    timestamp: '2026-07-17T02:00:00.000Z',
    source_file: null, dedup_key: 'ingest:1',
    attribution_version: null, attribution_status: null,
    project_id: null, session_id: null,
  })
  assert.deepEqual(decodeIngestBody({ device_id: 'd1', records: [] }, NOW).records, [])
})

test('decoder rejects invalid fields with a stable index and field', () => {
  const cases = [
    ['negative token', { input_tokens: -1 }, 'invalid_integer', 'input_tokens'],
    ['fractional token', { output_tokens: 1.5 }, 'invalid_integer', 'output_tokens'],
    ['empty model', { model: '  ' }, 'invalid_string', 'model'],
    ['invalid time', { timestamp: 'not-a-time' }, 'invalid_timestamp', 'timestamp'],
    ['future time', { timestamp: '2026-07-17T03:05:00.001Z' }, 'future_timestamp', 'timestamp'],
    ['negative cost', { cost_usd: -0.01 }, 'invalid_cost', 'cost_usd'],
    ['empty dedup', { dedup_key: '' }, 'invalid_string', 'dedup_key'],
    ['invalid flag', { output_includes_reasoning: 2 }, 'invalid_flag', 'output_includes_reasoning'],
    ['empty source', { source_file: ' ' }, 'invalid_string', 'source_file'],
  ] as const
  for (const [label, override, code, field] of cases) {
    assert.doesNotThrow(() => label)
    expectDecodeError(
      { device_id: 'd1', records: [validRecord(), validRecord(override)] },
      { code, record_index: 1, field },
    )
  }
})

test('decoder rejects malformed bodies, oversized batches, and duplicate keys', () => {
  expectDecodeError(null, { code: 'invalid_body' })
  expectDecodeError({ device_id: '', records: [] }, {
    code: 'invalid_string', field: 'device_id',
  })
  expectDecodeError({ device_id: 'd1', records: 'bad' }, { code: 'invalid_records' })
  expectDecodeError({
    device_id: 'd1',
    records: Array.from({ length: INGEST_MAX_RECORDS + 1 }, (_, index) => (
      validRecord({ dedup_key: `oversized:${index}` })
    )),
  }, { code: 'batch_too_large' })
  expectDecodeError({
    device_id: 'd1', records: [validRecord(), validRecord()],
  }, { code: 'duplicate_dedup_key', record_index: 1, field: 'dedup_key' })
})

test('decoder validates versioned attribution combinations', () => {
  const project = `prj_v1_${'a'.repeat(43)}`
  const session = `ses_v1_${'b'.repeat(43)}`
  const decoded = decodeIngestBody({
    device_id: 'd1', records: [validRecord({
      attribution_version: 1, attribution_status: 'captured',
      project_id: project, session_id: session,
    })],
  }, NOW).records[0]
  assert.deepEqual({
    version: decoded.attribution_version, status: decoded.attribution_status,
    project: decoded.project_id, session: decoded.session_id,
  }, { version: 1, status: 'captured', project, session })
  for (const [override, field] of [
    [{ attribution_status: 'captured', project_id: project }, 'attribution_version'],
    [{ attribution_version: 1, attribution_status: 'captured' }, 'attribution_status'],
    [{ attribution_version: 1, attribution_status: 'disabled', project_id: project }, 'project_id'],
    [{ attribution_version: 1, attribution_status: 'captured', session_id: 'raw' }, 'session_id'],
  ] as const) {
    expectDecodeError({ device_id: 'd1', records: [validRecord(override)] }, {
      code: 'invalid_attribution', record_index: 0, field,
    })
  }
})

test('route rejects the first invalid record before writing valid siblings', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  const response = await postIngest(app, {
    device_id: 'd1', records: [
      validRecord(),
      validRecord({ input_tokens: -1, dedup_key: 'ingest:bad' }),
    ],
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'record field is invalid',
    code: 'invalid_integer',
    record_index: 1,
    field: 'input_tokens',
  })
  assert.equal(recordCount(db), 0)
  db.close()
})

test('route enforces body and record limits while accepting the exact maximum', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  const oversized = JSON.stringify({
    device_id: 'd1', records: [], padding: 'x'.repeat(INGEST_MAX_BODY_BYTES),
  })
  const bodyResponse = await app.request('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversized,
  })
  assert.equal(bodyResponse.status, 413)
  assert.equal((await bodyResponse.json() as { code: string }).code, 'payload_too_large')
  const records = Array.from({ length: INGEST_MAX_RECORDS }, (_, index) => (
    validRecord({ dedup_key: `maximum:${index}` })
  ))
  const accepted = await postIngest(app, { device_id: 'd1', records })
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json() as { created: number }).created, INGEST_MAX_RECORDS)
  db.close()
})

test('route returns explicit no-op, missing-device, and forbidden-source results', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  const empty = await postIngest(app, { device_id: 'd1', records: [] })
  assert.deepEqual(await empty.json(), {
    ok: true, created: 0, updated: 0, unchanged: 0,
    total: 0, inserted: 0,
  })
  const missing = await postIngest(app, {
    device_id: 'missing', records: [validRecord()],
  })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json() as { code: string }).code, 'device_not_found')
  const forbidden = await postIngest(app, {
    device_id: 'd1', records: [validRecord({ provider: 'sub2api' })],
  })
  assert.equal(forbidden.status, 410)
  assert.equal((await forbidden.json() as { code: string }).code, 'forbidden_source')
  assert.equal(recordCount(db), 0)
  db.close()
})

test('route distinguishes create retry and update without duplicate effects', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  const body = { device_id: 'd1', records: [validRecord()] }
  assert.deepEqual(await (await postIngest(app, body)).json(), {
    ok: true, created: 1, updated: 0, unchanged: 0, total: 1, inserted: 1,
  })
  assert.deepEqual(await (await postIngest(app, body)).json(), {
    ok: true, created: 0, updated: 0, unchanged: 1, total: 1, inserted: 0,
  })
  const updated = await postIngest(app, {
    device_id: 'd1', records: [validRecord({
      input_tokens: 200, cost_usd: 1, cost_provided: true,
    })],
  })
  assert.deepEqual(await updated.json(), {
    ok: true, created: 0, updated: 1, unchanged: 0, total: 1, inserted: 1,
  })
  assert.deepEqual(db.prepare(`
    SELECT input_tokens, cost_usd, pricing_status FROM usage_records
    WHERE dedup_key = 'ingest:1'
  `).get(), { input_tokens: 200, cost_usd: 1, pricing_status: 'provided' })
  db.close()
})

test('captured attribution is idempotent, creates membership, and is not erased by replay', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  const project = `prj_v1_${'a'.repeat(43)}`
  const session = `ses_v1_${'b'.repeat(43)}`
  const captured = { device_id: 'd1', records: [validRecord({
    attribution_version: 1, attribution_status: 'captured',
    project_id: project, session_id: session,
  })] }
  assert.equal((await postIngest(app, captured)).status, 200)
  assert.deepEqual(await (await postIngest(app, captured)).json(), {
    ok: true, created: 0, updated: 0, unchanged: 1, total: 1, inserted: 0,
  })
  const disabled = { device_id: 'd1', records: [validRecord({
    attribution_version: 1, attribution_status: 'disabled',
  })] }
  assert.deepEqual(await (await postIngest(app, disabled)).json(), {
    ok: true, created: 0, updated: 0, unchanged: 1, total: 1, inserted: 0,
  })
  assert.equal((await postIngest(app, {
    device_id: 'd1', records: [validRecord()],
  })).status, 200)
  assert.deepEqual(db.prepare(`
    SELECT attribution_version, attribution_status, project_id, session_id
    FROM usage_records WHERE dedup_key = 'ingest:1'
  `).get(), {
    attribution_version: 1, attribution_status: 'captured', project_id: project, session_id: session,
  })
  assert.deepEqual(db.prepare(`
    SELECT device_id, project_id, first_seen_at, last_seen_at
    FROM attribution_projects
  `).get(), {
    device_id: 'd1', project_id: project,
    first_seen_at: '2026-07-17T02:00:00.000Z',
    last_seen_at: '2026-07-17T02:00:00.000Z',
  })
  db.close()
})

test('retry refreshes pricing metadata when an equivalent rule is replaced', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  const insertRule = db.prepare(`
    INSERT INTO pricing_rules (model, mode) VALUES ('mimo', 'free')
  `)
  const firstRuleId = Number(insertRule.run().lastInsertRowid)
  const body = { device_id: 'd1', records: [validRecord()] }
  await postIngest(app, body)
  db.prepare('DELETE FROM pricing_rules WHERE id = ?').run(firstRuleId)
  const replacementRuleId = Number(insertRule.run().lastInsertRowid)

  const retried = await postIngest(app, body)

  assert.deepEqual(await retried.json(), {
    ok: true, created: 0, updated: 1, unchanged: 0, total: 1, inserted: 1,
  })
  assert.deepEqual(db.prepare(`
    SELECT pricing_rule_id, pricing_source FROM usage_records
    WHERE dedup_key = 'ingest:1'
  `).get(), {
    pricing_rule_id: replacementRuleId,
    pricing_source: `rule:${replacementRuleId}`,
  })
  db.close()
})

test('route rejects cross-device dedup ownership without changing the owner', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app, 'd1')
  await registerDevice(app, 'd2')
  await postIngest(app, { device_id: 'd1', records: [validRecord()] })
  const conflict = await postIngest(app, {
    device_id: 'd2', records: [validRecord({ input_tokens: 999 })],
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), {
    error: 'dedup key belongs to another device',
    code: 'dedup_device_conflict', record_index: 0, field: 'dedup_key',
  })
  assert.deepEqual(db.prepare(`
    SELECT device_id, input_tokens FROM usage_records WHERE dedup_key = 'ingest:1'
  `).get(), { device_id: 'd1', input_tokens: 100 })
  db.close()
})

test('database failures roll back the whole batch and return a safe error', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevice(app)
  db.exec(`
    CREATE TRIGGER reject_fixture BEFORE INSERT ON usage_records
    WHEN NEW.dedup_key = 'ingest:trigger-failure'
    BEGIN SELECT RAISE(ABORT, 'fixture SQL detail'); END;
  `)
  const response = await postIngest(app, {
    device_id: 'd1', records: [
      validRecord(),
      validRecord({ dedup_key: 'ingest:trigger-failure' }),
    ],
  })
  assert.equal(response.status, 500)
  const payload = await response.json() as { error: string; code: string }
  assert.deepEqual(payload, { error: 'ingest failed', code: 'ingest_failed' })
  assert.doesNotMatch(JSON.stringify(payload), /fixture SQL detail|Authorization|API key/i)
  assert.equal(recordCount(db), 0)
  db.close()
})
