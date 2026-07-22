import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdminApi } from '../admin/api'
import { ApiError } from '../data/api-client'
import {
  decodeAuditCutovers,
  decodeAuditReconciliation,
  decodeAuditRecords,
  decodePublicAuditRecords,
  decodeAuditSummary,
} from './decoders'
import { auditSearchParams, auditSettingsHash, filtersFromHash } from './query'

const snapshot = {
  since: '2026-07-17T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
  timezone_offset: -480, max_record_id: 9,
}
const coverage = {
  priced_calls: 1, unpriced_calls: 0, priced_tokens: 110, unpriced_tokens: 0,
  call_ratio: 1, token_ratio: 1,
}
const metric = {
  records: 1, calls: 1, real_total_tokens: 110, cost_usd: 0.01,
  pricing_coverage: coverage, last_usage_at: '2026-07-17T01:00:00.000Z',
}
const record = {
  id: 9, device_id: 'd1', device_name: 'Device', provider: 'codex', model: 'gpt',
  request_count: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 20,
  cache_creation_tokens: 0, reasoning_tokens: 0, input_includes_cache_read: true,
  input_includes_cache_creation: false, output_includes_reasoning: false,
  fresh_input_tokens: 80, billable_output_tokens: 10, real_total_tokens: 110,
  cost_usd: 0.01, pricing_status: 'provided', timestamp: '2026-07-17T01:00:00.000Z',
  attribution_version: 1, attribution_status: 'captured',
  project_id: `prj_v1_${'a'.repeat(43)}`, session_id: `ses_v1_${'b'.repeat(43)}`,
  project_group_id: 1, project_name: 'Project A',
  source_file: 'codex', dedup_key: 'codex:1', pricing_rule_id: null,
  pricing_source: 'collector', created_at: '2026-07-17 01:00:00', is_authoritative: true,
  pricing_explanation: {
    status: 'exact', recomputed_cost_usd: 0.01, current_rule: null,
    evidence: 'Collector-provided cost is authoritative.',
  },
}

test('audit hash keeps the Dashboard snapshot and dimension filters', () => {
  const hash = auditSettingsHash(snapshot, 'd1', {
    since: '2026-07-17T01:00:00.000Z', until: '2026-07-17T02:00:00.000Z',
    provider: 'codex', model: 'gpt',
  })
  const filters = filtersFromHash(hash)
  assert.equal(new URLSearchParams(hash.split('?')[1]).get('panel'), 'audit')
  assert.deepEqual(filters, {
    since: '2026-07-17T01:00:00.000Z', until: '2026-07-17T02:00:00.000Z',
    timezone_offset: -480, snapshot_max_id: 9, device: 'd1', provider: 'codex',
    model: 'gpt', pricing_status: undefined, source_marker: undefined,
    dedup_key: undefined, project_group_id: undefined, session_id: undefined,
    visibility: 'authoritative',
  })
  assert.equal(auditSearchParams(filters).get('snapshot_max_id'), '9')
})

test('audit decoders validate records summaries reconciliation and cutovers', () => {
  const page = decodeAuditRecords({
    snapshot, visibility: 'authoritative', rows: [record], next_cursor: 'next',
  })
  assert.equal(page.rows[0].real_total_tokens, 110)
  assert.equal(page.rows[0].pricing_explanation.status, 'exact')
  assert.equal(page.rows[0].project_name, 'Project A')
  const summary = decodeAuditSummary({
    snapshot, selected: metric, authoritative: metric, physical: metric,
    hidden: { ...metric, records: 0 },
  })
  assert.equal(summary.authoritative.calls, 1)
  const reconciliation = decodeAuditReconciliation({
    snapshot, run_since: snapshot.since, run_until: snapshot.until,
    telemetry_coverage: {
      coverage_since: '2026-07-01T00:00:00.000Z',
      earliest_retained_at: '2026-07-01T00:00:00.000Z',
      latest_retained_at: snapshot.until, truncated: true,
    },
    rows: [{
      device_id: 'd1', device_name: 'Device', source: 'codex', runs: 1,
      successful_runs: 1, failed_runs: 0, emitted: 1, accepted: 1, unchanged: 0,
      unknown_acknowledgements: 0, pipeline_balance: 0,
      latest_watermark_at: snapshot.until, reported_last_usage_at: snapshot.until,
      ledger: metric,
    }],
  })
  assert.equal(reconciliation.rows[0].pipeline_balance, 0)
  assert.equal(reconciliation.telemetry_coverage.truncated, true)
  const cutovers = decodeAuditCutovers({ rows: [{
    id: 1, device_id: 'd1', device_name: 'Device', provider: 'codex',
    previous_cutover_at: null, cutover_at: snapshot.since, actor: 'collector',
    reason: 'initial', created_at: snapshot.since,
  }], next_cursor: null })
  assert.equal(cutovers.rows[0].actor, 'collector')
  assert.throws(() => decodeAuditRecords({
    snapshot, visibility: 'authoritative', rows: [{ ...record, pricing_explanation: undefined }],
    next_cursor: null,
  }))
})

test('public audit decoder accepts records without admin-only fields', () => {
  const page = decodePublicAuditRecords({
    snapshot, visibility: 'authoritative',
    rows: [{ ...record, source_file: undefined, dedup_key: undefined,
      pricing_rule_id: undefined, pricing_source: undefined, created_at: undefined,
      is_authoritative: undefined, pricing_explanation: undefined }],
    next_cursor: null,
  })
  assert.equal(page.rows[0].provider, 'codex')
  assert.equal(page.rows[0].project_name, 'Project A')
})

test('admin audit API includes cookie credentials and rejects partial payloads', async () => {
  let credentials: RequestCredentials | undefined
  const api = createAdminApi('', (_input, init) => {
    credentials = init?.credentials
    return Promise.resolve(Response.json({
      snapshot, visibility: 'authoritative', rows: [record], next_cursor: null,
    }))
  })
  const filters = filtersFromHash(auditSettingsHash(snapshot, 'd1'))
  const page = await api.auditRecords(filters)
  assert.equal(page.rows.length, 1)
  assert.equal(credentials, 'include')

  const invalid = createAdminApi('', () => Promise.resolve(Response.json({
    snapshot, visibility: 'authoritative', rows: [{}], next_cursor: null,
  })))
  await assert.rejects(invalid.auditRecords(filters), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.kind, 'invalid-response')
    return true
  })
})
