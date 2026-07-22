import assert from 'node:assert/strict'
import test from 'node:test'

import { getAuditRecords, getAuditSummary } from './audit.js'
import {
  ensureProjectMembership,
  getProjectAttribution,
  mergeProjectMembership,
  updateProjectGroupName,
} from './attribution.js'
import { initDB } from './db.js'
import { getStatsResponse } from './stats.js'

const PROJECT_A = `prj_v1_${'a'.repeat(43)}`
const PROJECT_B = `prj_v1_${'b'.repeat(43)}`
const SESSION_A = `ses_v1_${'c'.repeat(43)}`
const SESSION_B = `ses_v1_${'d'.repeat(43)}`

function insertUsage(db: ReturnType<typeof initDB>, input: {
  device: string
  key: string
  calls: number
  input: number
  output: number
  cost: number
  status?: 'captured' | 'disabled' | 'unsupported'
  project?: string
  session?: string
}) {
  db.prepare(`
    INSERT INTO usage_records
      (device_id, provider, model, request_count, input_tokens, output_tokens,
       input_includes_cache_read, input_includes_cache_creation,
       output_includes_reasoning, cost_usd, pricing_status, timestamp,
       source_file, dedup_key, attribution_version, attribution_status,
       project_id, session_id)
    VALUES (?, 'gemini', 'gemini-test', ?, ?, ?, 0, 0, 0, ?, 'provided',
      '2026-07-18T01:00:00.000Z', 'gemini', ?, ?, ?, ?, ?)
  `).run(
    input.device, input.calls, input.input, input.output, input.cost, input.key,
    input.status ? 1 : null, input.status ?? null,
    input.project ?? null, input.session ?? null,
  )
  if (input.status === 'captured' && input.project) {
    ensureProjectMembership(
      db, input.device, input.project, '2026-07-18T01:00:00.000Z',
    )
  }
}

test('project groups remain isolated until explicit merge and preserve ledger totals', () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device 1')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d2', 'Device 2')
  insertUsage(db, {
    device: 'd1', key: 'a', calls: 2, input: 100, output: 20, cost: 1,
    status: 'captured', project: PROJECT_A, session: SESSION_A,
  })
  insertUsage(db, {
    device: 'd2', key: 'b', calls: 3, input: 200, output: 30, cost: 2,
    status: 'captured', project: PROJECT_B, session: SESSION_B,
  })
  insertUsage(db, {
    device: 'd1', key: 'disabled', calls: 1, input: 10, output: 0, cost: 0,
    status: 'disabled',
  })
  insertUsage(db, {
    device: 'd1', key: 'legacy', calls: 1, input: 5, output: 0, cost: 0,
  })

  const initial = getProjectAttribution(db)
  assert.equal(initial.groups.length, 2)
  const [first, second] = initial.groups
  assert.ok(first && second)
  assert.equal(updateProjectGroupName(db, first.id, 'Shared name'), true)
  assert.equal(updateProjectGroupName(db, second.id, 'Shared name'), true)
  assert.equal(getProjectAttribution(db).groups.length, 2)

  assert.equal(mergeProjectMembership(
    db, second.members[0]!.device_id, second.members[0]!.project_id, first.id,
  ), true)
  const merged = getProjectAttribution(db)
  assert.equal(merged.groups.length, 1)
  assert.equal(merged.groups[0]?.members.length, 2)
  assert.equal(merged.groups[0]?.calls, 5)
  assert.equal(updateProjectGroupName(db, first.id, null), true)

  const stats = getStatsResponse(db, {
    since: '2026-07-18T00:00:00.000Z', until: '2026-07-19T00:00:00.000Z',
    project_group_id: String(first.id),
  })
  assert.equal(stats.totals.total_calls, 5)
  assert.equal(stats.totals.real_total_tokens, 350)
  assert.equal(stats.totals.total_cost, 3)
  assert.equal(stats.byProject[0]?.members, 2)
  assert.equal(stats.bySession.length, 2)
  assert.equal(stats.attribution.find(row => row.status === 'captured')?.records, 2)

  const query = {
    since: stats.snapshot.since, until: stats.snapshot.until,
    snapshot_max_id: String(stats.snapshot.max_record_id),
    project_group_id: String(first.id), visibility: 'authoritative',
  }
  const audit = getAuditSummary(db, query)
  assert.equal(audit.selected.calls, stats.totals.total_calls)
  assert.equal(audit.selected.real_total_tokens, stats.totals.real_total_tokens)
  assert.equal(audit.selected.cost_usd, stats.totals.total_cost)
  const session = getAuditRecords(db, { ...query, session_id: SESSION_A }, true)
  assert.equal(session.rows.length, 1)
  assert.equal(session.rows[0]?.project_group_id, first.id)
  assert.equal(session.rows[0]?.attribution_status, 'captured')

  assert.equal((db.prepare('SELECT COUNT(*) count FROM usage_records').get() as { count: number }).count, 4)
  db.close()
})
