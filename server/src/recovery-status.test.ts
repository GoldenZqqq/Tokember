import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initDB } from './db.js'
import { getRecoveryStatus } from './recovery-status.js'
import { getSystemInfo } from './system-info.js'

const NOW = new Date('2026-07-18T12:00:00.000Z')

function rawStatus(overrides: Record<string, unknown> = {}) {
  return {
    status_schema_version: 1,
    last_attempt_at: '2026-07-18T11:00:00.000Z',
    last_success_at: '2026-07-18T11:00:00.000Z',
    last_failure_at: null,
    backup_bytes: 55_947_264,
    backup_schema_version: 9,
    integrity: 'passed',
    error_code: null,
    drill: {
      state: 'passed',
      last_attempt_at: '2026-07-18T11:00:00.000Z',
      last_success_at: '2026-07-18T11:00:00.000Z',
      duration_ms: 1_234,
    },
    private_path: '/opt/private/tokember.db',
    raw_error: 'secret failure detail',
    ...overrides,
  }
}

test('missing recovery status has explicit never semantics', () => {
  assert.deepEqual(getRecoveryStatus(undefined, { now: NOW }), {
    state: 'never',
    last_attempt_at: null,
    last_success_at: null,
    last_failure_at: null,
    age_seconds: null,
    backup_bytes: null,
    schema_version: null,
    integrity: 'never',
    error_code: null,
    drill: {
      state: 'never', last_attempt_at: null, last_success_at: null, duration_ms: null,
    },
  })
})

test('valid recovery status projects only safe aggregate fields and age', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-recovery-status-'))
  const path = join(root, 'status.json')
  try {
    await writeFile(path, JSON.stringify(rawStatus()))
    const status = getRecoveryStatus(path, { now: NOW })
    assert.equal(status.state, 'healthy')
    assert.equal(status.age_seconds, 3_600)
    assert.equal(status.backup_bytes, 55_947_264)
    assert.equal(status.schema_version, 9)
    assert.equal(status.drill.duration_ms, 1_234)
    assert.doesNotMatch(JSON.stringify(status), /private|tokember\.db|secret failure/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stale backup and latest backup or drill failures have distinct safe states', () => {
  const stale = getRecoveryStatus('ignored', {
    now: NOW,
    readFile: () => JSON.stringify(rawStatus({
      last_success_at: '2026-07-17T10:00:00.000Z',
    })),
  })
  assert.equal(stale.state, 'stale')
  assert.equal(stale.age_seconds, 93_600)

  const backupFailed = getRecoveryStatus('ignored', {
    now: NOW,
    readFile: () => JSON.stringify(rawStatus({
      last_failure_at: '2026-07-18T11:30:00.000Z', error_code: 'busy',
    })),
  })
  assert.equal(backupFailed.state, 'backup_failed')
  assert.equal(backupFailed.error_code, 'busy')

  const drillFailed = getRecoveryStatus('ignored', {
    now: NOW,
    readFile: () => JSON.stringify(rawStatus({
      last_failure_at: '2026-07-18T11:30:00.000Z',
      error_code: 'smoke',
      drill: {
        state: 'failed', last_attempt_at: '2026-07-18T11:30:00.000Z',
        last_success_at: null, duration_ms: null,
      },
    })),
  })
  assert.equal(drillFailed.state, 'drill_failed')
  assert.equal(drillFailed.drill.state, 'failed')
})

test('malformed or unreadable status returns one redacted failure shape', () => {
  for (const readFile of [
    () => '{not-json',
    () => JSON.stringify(rawStatus({ backup_bytes: -1 })),
    () => { throw new Error('/private/path permission denied') },
  ]) {
    const status = getRecoveryStatus('ignored', { now: NOW, readFile })
    assert.equal(status.state, 'backup_failed')
    assert.equal(status.error_code, 'status')
    assert.doesNotMatch(JSON.stringify(status), /private|permission|not-json/)
  }
})

test('System Info exposes recovery projection and only fixed health notes', () => {
  const db = initDB(':memory:')
  try {
    const info = getSystemInfo(db, '/opt/private/data/tokember.db', {
      env: { TOKEMBER_RECOVERY_STATUS_PATH: '/opt/private/status.json' },
      now: NOW,
      readRecoveryFile: () => JSON.stringify(rawStatus({
        last_success_at: '2026-07-17T10:00:00.000Z',
      })),
    })
    assert.equal(info.recovery.state, 'stale')
    assert.deepEqual(info.health.notes, ['数据库备份已超过 24 小时'])
    assert.doesNotMatch(JSON.stringify(info), /opt\/private|secret failure/)
  } finally {
    db.close()
  }
})
