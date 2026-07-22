import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildCollectorRunReport,
  applySuccessfulSourceStates,
  collectObservableSources,
  finishPendingRun,
  flushPendingRuns,
  recoverAndBeginRun,
  sanitizeCollectorError,
  startCollectorRun,
  uploadObservableSources,
} from './collector-observability.js'
import {
  emptyCollectorState,
  emptyIncrementalSourceState,
  getIncrementalSourceState,
} from './collector-state.js'

function usage(dedupKey: string) {
  return {
    provider: 'codex', model: 'gpt', input_tokens: 1, output_tokens: 1,
    cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
    cost_usd: 0, timestamp: '2026-07-17T00:00:00.000Z',
    source_file: 'codex', dedup_key: dedupKey,
  }
}

function runStart() {
  return startCollectorRun({
    device_id: 'd1', collector_kind: 'native', collector_version: '0.1.0',
    schedule_interval_minutes: 30,
  }, new Date('2026-07-17T00:00:00.000Z'))
}

test('source collection continues after one failure and redacts its error', async () => {
  const collections = await collectObservableSources([
    {
      source: 'codex',
      collect: async observer => {
        observer.discover(3)
        observer.scan('2026-07-17T00:00:00.000Z')
        return [usage('one')]
      },
    },
    {
      source: 'gemini',
      collect: async observer => {
        observer.discover(2)
        throw new Error('C:\\Users\\Alice\\secret.json Bearer token-value')
      },
    },
  ])
  const reports = await uploadObservableSources(collections, async records => ({
    precision: 'exact', created: records.length, updated: 0, unchanged: 0,
    total: records.length, inserted: records.length, changed: records.length,
  }))
  const report = buildCollectorRunReport(
    runStart(), reports, new Date('2026-07-17T00:00:01.000Z'),
  )

  assert.equal(report.status, 'partial')
  assert.equal(report.accepted, null)
  assert.deepEqual(reports.map(source => source.status), ['success', 'collection_failed'])
  assert.equal(reports[0].discovered, 3)
  assert.doesNotMatch(reports[1].error_summary!, /Alice|token-value/)
})

test('empty source run succeeds with an exact zero acknowledgement', async () => {
  const collections = await collectObservableSources([{
    source: 'codex',
    collect: async observer => { observer.discover(2); observer.scan(); return [] },
  }])
  const reports = await uploadObservableSources(collections, async records => {
    assert.deepEqual(records, [])
    return {
      precision: 'exact', created: 0, updated: 0, unchanged: 0,
      total: 0, inserted: 0, changed: 0,
    }
  })
  const report = buildCollectorRunReport(runStart(), reports)
  assert.equal(report.status, 'success')
  assert.equal(report.emitted, 0)
  assert.equal(report.accepted, 0)
  assert.equal(report.unchanged, 0)
  assert.ok(report.sources.some(source => (
    source.source === 'collector' && source.status === 'success'
  )))
})

test('successful tool run reports collector runtime success to clear sticky failure', () => {
  const report = buildCollectorRunReport(runStart(), [{
    source: 'codex', status: 'success', discovered: 1, scanned: 1,
    emitted: 1, accepted: 1, unchanged: 0, watermark_at: null,
    last_usage_at: '2026-07-17T00:00:00.000Z', duration_ms: 10, error_summary: null,
  }], new Date('2026-07-17T00:00:01.000Z'))
  assert.equal(report.status, 'success')
  assert.equal(report.accepted, 1)
  assert.equal(report.unchanged, 0)
  assert.deepEqual(
    report.sources.map(source => [source.source, source.status, source.accepted]),
    [['codex', 'success', 1], ['collector', 'success', 0]],
  )
})

test('partial or failed tool runs do not invent collector runtime success', () => {
  const partial = buildCollectorRunReport(runStart(), [{
    source: 'codex', status: 'success', discovered: 1, scanned: 1,
    emitted: 0, accepted: 0, unchanged: 0, watermark_at: null,
    last_usage_at: null, duration_ms: 1, error_summary: null,
  }, {
    source: 'gemini', status: 'collection_failed', discovered: 0, scanned: 0,
    emitted: 0, accepted: null, unchanged: null, watermark_at: null,
    last_usage_at: null, duration_ms: 1, error_summary: 'boom',
  }])
  assert.equal(partial.status, 'partial')
  assert.equal(partial.sources.some(source => source.source === 'collector'), false)

  const failed = buildCollectorRunReport(runStart(), [{
    source: 'collector', status: 'collection_failed', discovered: 0, scanned: 0,
    emitted: 0, accepted: null, unchanged: null, watermark_at: null,
    last_usage_at: null, duration_ms: 0, error_summary: 'register timed out',
  }])
  assert.equal(failed.status, 'failed')
  assert.equal(failed.sources.length, 1)
  assert.equal(failed.sources[0].status, 'collection_failed')
})

test('upload failure uses unknown acknowledgement instead of invented zero', async () => {
  const collections = await collectObservableSources([{
    source: 'codex',
    collect: async observer => { observer.discover(); observer.scan(); return [usage('one')] },
  }])
  const [report] = await uploadObservableSources(collections, async () => {
    throw new Error('upload failed')
  })
  assert.equal(report.status, 'upload_failed')
  assert.equal(report.emitted, 1)
  assert.equal(report.accepted, null)
  assert.equal(report.unchanged, null)
})

test('successful source duration includes collection and upload work', async () => {
  const collection = {
    source: 'codex', records: [usage('duration')], discovered: 1, scanned: 1,
    watermark_at: null, duration_ms: 125, error_summary: null, state_candidate: null,
  }
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const [report] = await uploadObservableSources([collection], async records => {
      now += 75
      return {
        precision: 'exact', created: records.length, updated: 0, unchanged: 0,
        total: records.length, inserted: records.length, changed: records.length,
      }
    })
    assert.equal(report.duration_ms, 200)
  } finally {
    Date.now = originalNow
  }
})

test('only successfully uploaded sources apply incremental state candidates', async () => {
  const initial = emptyIncrementalSourceState()
  const collections = await collectObservableSources([
    {
      source: 'codex', incremental_state: initial,
      collect: async (_observer, cursor) => { cursor!.setValue('offset', 10); return [] },
    },
    {
      source: 'gemini', incremental_state: initial,
      collect: async (_observer, cursor) => { cursor!.setValue('offset', 20); return [] },
    },
  ])
  const reports = await uploadObservableSources(collections, async records => {
    if (records === collections[1].records) throw new Error('upload failed')
    return {
      precision: 'exact', created: 0, updated: 0, unchanged: 0,
      total: 0, inserted: 0, changed: 0,
    }
  })
  const state = emptyCollectorState()
  assert.deepEqual(applySuccessfulSourceStates({
    state, deviceId: 'd1', collections, reports,
  }), ['codex'])
  assert.equal(getIncrementalSourceState(state, 'd1', 'codex').values.offset, 10)
  assert.equal(getIncrementalSourceState(state, 'd1', 'gemini').values.offset, undefined)
})

test('outbox recovers abandoned runs and removes only acknowledged reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-observability-'))
  const path = join(directory, 'outbox.json')
  const first = runStart()
  const second = { ...runStart(), run_id: 'second', started_at: '2026-07-17T00:01:00.000Z' }
  try {
    await recoverAndBeginRun(first, path)
    await recoverAndBeginRun(second, path)
    const state = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(state.running[0].run_id, 'second')
    assert.equal(state.reports[0].status, 'failed')

    const completed = buildCollectorRunReport(second, [{
      source: 'codex', status: 'success', discovered: 0, scanned: 0,
      emitted: 0, accepted: 0, unchanged: 0, watermark_at: null,
      last_usage_at: null, duration_ms: 0, error_summary: null,
    }], new Date('2026-07-17T00:01:01.000Z'))
    await finishPendingRun(completed, path)
    assert.equal(await flushPendingRuns(async report => {
      if (report.run_id !== 'second') throw new Error('still unavailable')
    }, path), 1)
    const retained = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(retained.running.length, 0)
    assert.equal(retained.reports.length, 1)
    assert.notEqual(retained.reports[0].run_id, 'second')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('collector error sanitizer bounds secret and path content', () => {
  const result = sanitizeCollectorError(
    'Authorization=Bearer secret X-API-Key: second-secret API_KEY="quoted value" '
    + 'TOKEMBER_DEVICE_TOKEN=tkdc_abcdefghijkl_abcdefghijklmnopqrstuvwxyz123456 '
    + '/home/user/private/session.json ' + 'x'.repeat(800),
  )
  assert.doesNotMatch(result, /secret|quoted|value|user|session\.json|tkdc_/)
  assert.ok(result.length <= 500)
})
