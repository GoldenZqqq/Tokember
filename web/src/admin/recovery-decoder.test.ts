import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSystemInfo } from './decoders'

function payload(recovery?: unknown) {
  return {
    version: '0.1.0', started_at: '2026-07-18T00:00:00.000Z', node_env: 'production',
    db_path: 'data/tokember.db', db_ok: true,
    counts: { devices: 1, usage_records: 2, pricing_rules: 3 },
    pricing_status: [], devices: [], health: {
      status: 'ok', online_devices: 1, offline_devices: 0, notes: [],
    },
    ...(recovery === undefined ? {} : { recovery }),
  }
}

test('old System Info responses decode with a never recovery fallback', () => {
  assert.equal(decodeSystemInfo(payload()).recovery.state, 'never')
})

test('System Info recovery decoder accepts safe status and ignores unknown fields', () => {
  const info = decodeSystemInfo(payload({
    state: 'healthy', last_attempt_at: '2026-07-18T11:00:00.000Z',
    last_success_at: '2026-07-18T11:00:00.000Z',
    last_failure_at: null, age_seconds: 3_600, backup_bytes: 55_947_264,
    schema_version: 9, integrity: 'passed', error_code: null,
    drill: {
      state: 'passed', last_attempt_at: '2026-07-18T11:00:00.000Z',
      last_success_at: '2026-07-18T11:00:00.000Z', duration_ms: 1_234,
    },
    private_path: '/opt/private/tokember.db', raw_error: 'secret detail',
  }))
  assert.equal(info.recovery.state, 'healthy')
  assert.equal(info.recovery.backup_bytes, 55_947_264)
  assert.equal(info.recovery.drill.duration_ms, 1_234)
  assert.doesNotMatch(JSON.stringify(info.recovery), /private|secret detail|tokember\.db/)
})

test('malformed recovery state is rejected at the Admin boundary', () => {
  assert.throws(() => decodeSystemInfo(payload({
    state: 'healthy', last_attempt_at: null, last_success_at: null,
    last_failure_at: null, age_seconds: null, backup_bytes: null,
    schema_version: null, integrity: 'passed', error_code: 'private_error',
    drill: { state: 'never', last_attempt_at: null, last_success_at: null, duration_ms: null },
  })))
})
