import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../data/api-client'
import { createAdminApi } from './api'

function assertKind(error: unknown, kind: ApiError['kind']): boolean {
  assert.ok(error instanceof ApiError)
  assert.equal(error.kind, kind)
  return true
}

test('admin API preserves cookie credentials and decodes session', async () => {
  let credentials: RequestCredentials | undefined
  const api = createAdminApi('', (_input, init) => {
    credentials = init?.credentials
    return Promise.resolve(Response.json({ authenticated: true }))
  })
  assert.deepEqual(await api.session(), { authenticated: true })
  assert.equal(credentials, 'include')
})

test('admin API rejects invalid success shapes instead of casting them', async () => {
  const api = createAdminApi('', () => Promise.resolve(Response.json({ authenticated: 'yes' })))
  await assert.rejects(api.session(), error => assertKind(error, 'invalid-response'))
})

test('admin API keeps 401 distinct from transport failures', async () => {
  const unauthorized = createAdminApi('', () =>
    Promise.resolve(Response.json({ error: '密码错误' }, { status: 401 })))
  await assert.rejects(unauthorized.login('bad'), error => assertKind(error, 'auth'))

  const offline = createAdminApi('', () => Promise.reject(new TypeError('offline')))
  await assert.rejects(offline.session(), error => assertKind(error, 'network'))
})

test('admin API decodes collector health and rejects missing run state', async () => {
  const payload = {
    id: 'd1', name: 'Device', created_at: '2026-07-17 00:00:00',
    last_seen_at: '2026-07-17T01:00:00.000Z', prev_seen_at: null,
    record_count: 2, last_record_at: '2026-07-17T00:59:00.000Z',
    collector: {
      status: 'degraded', online: true, freshness_threshold_minutes: 75,
      last_successful_at: '2026-07-17T00:30:00.000Z',
      latest_run: {
        run_id: 'run-1', status: 'partial', started_at: '2026-07-17T00:59:00.000Z',
        finished_at: '2026-07-17T01:00:00.000Z', duration_ms: 1000,
        schedule_interval_minutes: 30, emitted: 2, accepted: null,
        unchanged: null, error_summary: 'gemini failed',
      },
      sources: [{
        source: 'gemini', status: 'upload_failed', discovered: 4, scanned: 4,
        emitted: 2, accepted: null, unchanged: null, watermark_at: null,
        last_usage_at: '2026-07-17T00:59:00.000Z', duration_ms: 900,
        error_summary: 'upload failed', finished_at: '2026-07-17T01:00:00.000Z',
        consecutive_failures: 2,
      }],
    },
  }
  const api = createAdminApi('', () => Promise.resolve(Response.json({ devices: [payload] })))
  const result = await api.devices()
  assert.equal(result.devices[0].collector.status, 'degraded')
  assert.equal(result.devices[0].collector.sources[0].accepted, null)
  assert.equal(result.devices[0].platform, null)

  const invalid = createAdminApi('', () => Promise.resolve(Response.json({
    devices: [{ ...payload, collector: undefined }],
  })))
  await assert.rejects(invalid.devices(), error => assertKind(error, 'invalid-response'))

  const invalidPlatform = createAdminApi('', () => Promise.resolve(Response.json({
    devices: [{ ...payload, platform: 'android' }],
  })))
  await assert.rejects(invalidPlatform.devices(), error => assertKind(error, 'invalid-response'))
})

test('admin device credential API decodes metadata and one-time tokens', async () => {
  const credential = {
    id: 1, token_id: 'abcdefghijkl', device_id: 'd1', device_name: 'Device',
    label: 'Primary', created_at: '2026-07-18T00:00:00.000Z',
    last_used_at: null, revoked_at: null,
  }
  let call = 0
  const api = createAdminApi('', () => Promise.resolve(Response.json(call++ === 0
    ? { credentials: [credential], legacy_api_key_allowed: false }
    : { credential, token: 'tkdc_abcdefghijkl_abcdefghijklmnopqrstuvwxyz123456' })))
  const listed = await api.deviceCredentials()
  assert.equal(listed.credentials[0].device_id, 'd1')
  assert.equal(listed.legacy_api_key_allowed, false)
  const created = await api.createDeviceCredential({ device_id: 'd1', label: 'Primary' })
  assert.match(created.token, /^tkdc_/)

  const invalid = createAdminApi('', () => Promise.resolve(Response.json({
    credentials: [{ ...credential, id: 'bad' }],
    legacy_api_key_allowed: true,
  })))
  await assert.rejects(invalid.deviceCredentials(), error => assertKind(error, 'invalid-response'))
})

test('admin alert API keeps cookies and rejects malformed evidence', async () => {
  const payload = {
    webhook_configured: false,
    rules: [{
      id: 1, name: 'Budget', kind: 'budget', device_id: null, provider: null,
      timezone: 'Asia/Shanghai', enabled: true, cooldown_minutes: 60,
      notify_webhook: false, created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
      config: { period: 'day', metric: 'cost', limit: 10 }, evaluation: null,
    }],
    events: [],
  }
  let credentials: RequestCredentials | undefined
  const api = createAdminApi('', (_input, init) => {
    credentials = init?.credentials
    return Promise.resolve(Response.json(payload))
  })
  const center = await api.alerts()
  assert.equal(center.rules[0].kind, 'budget')
  assert.equal(credentials, 'include')

  const invalid = createAdminApi('', () => Promise.resolve(Response.json({
    ...payload,
    events: [{
      id: 1, rule_id: 1, rule_name: 'Budget', kind: 'budget',
      device_id: null, provider: null, dedup_key: 'key', status: 'active',
      severity: 'warning', first_triggered_at: 'now', last_triggered_at: 'now',
      recovered_at: null, acknowledged_at: null, cooldown_until: 'later',
      notification_status: 'pending', evidence: { kind: 'budget' },
    }],
  })))
  await assert.rejects(invalid.alerts(), error => assertKind(error, 'invalid-response'))
})

test('admin project attribution API decodes groups and sends explicit merge input', async () => {
  const coverage = {
    priced_calls: 1, unpriced_calls: 0, priced_tokens: 10, unpriced_tokens: 0,
    call_ratio: 1, token_ratio: 1,
  }
  let mergeBody: Record<string, unknown> | null = null
  const api = createAdminApi('', (input, init) => {
    if (String(input).endsWith('/attribution/projects/merge')) {
      mergeBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(Response.json({ ok: true, group_id: 2 }))
    }
    return Promise.resolve(Response.json({ groups: [{
      id: 1, display_name: null, calls: 1, real_total_tokens: 10, cost: 1,
      pricing_coverage: coverage,
      members: [{
        device_id: 'd1', device_name: 'Device', project_id: `prj_v1_${'a'.repeat(43)}`,
        first_seen_at: '2026-07-18T00:00:00.000Z', last_seen_at: '2026-07-18T01:00:00.000Z',
        calls: 1, real_total_tokens: 10, cost: 1, pricing_coverage: coverage,
      }],
    }] }))
  })
  const listed = await api.projectAttribution()
  assert.equal(listed.groups[0]?.members[0]?.device_name, 'Device')
  await api.mergeProject('d1', `prj_v1_${'a'.repeat(43)}`, 2)
  assert.deepEqual(mergeBody, {
    device_id: 'd1', project_id: `prj_v1_${'a'.repeat(43)}`, target_group_id: 2,
  })
})
