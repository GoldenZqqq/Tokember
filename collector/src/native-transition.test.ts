import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  finalizableNativePlans,
  finalizeAfterSuccessfulIngest,
  finalizeNativeProgress,
  FULL_HISTORY_CUTOVER,
  planNativeCollection,
} from './native-transition.js'
import {
  emptyCollectorState,
  emptyIncrementalSourceState,
  getCheckpoint,
  loadCollectorState,
  saveCollectorState,
  setIncrementalSourceState,
} from './collector-state.js'
import { ServerClient, type SourceAuthorityState } from './server-client.js'

const until = '2026-07-15T12:00:00.000Z'

function authority(overrides: Partial<SourceAuthorityState> = {}): SourceAuthorityState {
  return {
    provider: 'claude',
    cutover_at: null,
    legacy_history: false,
    legacy_coverage_end: null,
    ...overrides,
  }
}

test('fresh providers backfill native history before locking native authority', () => {
  const plan = planNativeCollection({
    authority: authority(), checkpoint: undefined, until, legacyAvailable: false,
  })
  assert.equal(plan.window.since, undefined)
  assert.equal(plan.bootstrap_since, null)
  assert.equal(plan.pending_cutover, FULL_HISTORY_CUTOVER)
  assert.equal(plan.collect_legacy, false)
})

test('legacy providers perform a final local read before committing cutover', () => {
  const plan = planNativeCollection({
    authority: authority({ legacy_history: true }),
    checkpoint: undefined, until, legacyAvailable: true,
  })
  assert.equal(plan.window.since, '2026-07-15T11:55:00.000Z')
  assert.equal(plan.pending_cutover, '2026-07-15T11:55:00.000Z')
  assert.equal(plan.collect_legacy, true)
})

test('missing local legacy source resumes from server coverage watermark', () => {
  const coverage = '2026-07-14T00:00:00.000Z'
  const plan = planNativeCollection({
    authority: authority({ legacy_history: true, legacy_coverage_end: coverage }),
    checkpoint: undefined, until, legacyAvailable: false,
  })
  assert.equal(plan.window.since, coverage)
  assert.equal(plan.pending_cutover, coverage)
  assert.equal(plan.collect_legacy, false)
})

test('committed cutover wins over an older checkpoint', () => {
  const cutover = '2026-07-15T10:00:00.000Z'
  const plan = planNativeCollection({
    authority: authority({ cutover_at: cutover }),
    checkpoint: '2026-07-15T09:00:00.000Z', until, legacyAvailable: true,
  })
  assert.equal(plan.window.since, cutover)
  assert.equal(plan.bootstrap_since, cutover)
  assert.equal(plan.pending_cutover, null)
  assert.equal(plan.collect_legacy, false)
})

test('checkpoint overlap seeds v1 bootstrap but never filters incremental events', () => {
  const cutover = '2026-07-15T10:00:00.000Z'
  const plan = planNativeCollection({
    authority: authority({ cutover_at: cutover }),
    checkpoint: '2026-07-15T11:00:00.000Z', until, legacyAvailable: true,
  })
  assert.equal(plan.window.since, cutover)
  assert.equal(plan.bootstrap_since, '2026-07-15T10:55:00.000Z')
})

test('failed cutover commit does not advance or save checkpoints', async () => {
  const state = emptyCollectorState()
  const plans = [
    planNativeCollection({
      authority: authority({ provider: 'claude' }),
      checkpoint: undefined, until, legacyAvailable: false,
    }),
    planNativeCollection({
      authority: authority({ provider: 'codex' }),
      checkpoint: undefined, until, legacyAvailable: false,
    }),
  ]
  let commits = 0
  let staged = false
  let saved = false
  await assert.rejects(() => finalizeNativeProgress({
    plans, state, deviceId: 'd1', until,
    commit: async () => {
      commits += 1
      if (commits === 2) throw new Error('commit failed')
    },
    stage: () => { staged = true },
    save: async () => { saved = true },
  }), /commit failed/)
  assert.equal(staged, false)
  assert.equal(saved, false)
  assert.equal(getCheckpoint(state, 'd1', 'claude'), undefined)
  assert.equal(getCheckpoint(state, 'd1', 'codex'), undefined)
})

test('source candidates and native checkpoints share one state save', async () => {
  const state = emptyCollectorState()
  const plans = [planNativeCollection({
    authority: authority(), checkpoint: undefined, until, legacyAvailable: false,
  })]
  let saves = 0
  await finalizeNativeProgress({
    plans, state, deviceId: 'd1', until,
    commit: async () => {},
    stage: candidate => {
      candidate.devices.d1 = {
        providers: {},
        sources: {},
      }
    },
    save: async candidate => {
      saves += 1
      assert.equal(getCheckpoint(candidate, 'd1', 'claude'), until)
      assert.ok(candidate.devices.d1)
    },
  })
  assert.equal(saves, 1)
})

test('failed state save leaves the previously confirmed file unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-state-save-failure-'))
  const path = join(directory, 'state.json')
  const confirmed = emptyCollectorState()
  try {
    await saveCollectorState(confirmed, path)
    const candidate = await loadCollectorState(path)
    await assert.rejects(finalizeNativeProgress({
      plans: [], state: candidate, deviceId: 'd1', until,
      commit: async () => {},
      stage: state => {
        const sourceState = emptyIncrementalSourceState()
        sourceState.values.offset = 42
        setIncrementalSourceState(state, {
          deviceId: 'd1', source: 'codex', sourceState,
        })
      },
      save: async () => { throw new Error('disk full') },
    }), /disk full/)
    assert.deepEqual(await loadCollectorState(path), confirmed)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('only successfully uploaded native plans advance their checkpoints', async () => {
  const plans = [
    planNativeCollection({
      authority: authority({ provider: 'claude', legacy_history: true }),
      checkpoint: undefined, until, legacyAvailable: true,
    }),
    planNativeCollection({
      authority: authority({ provider: 'codex' }),
      checkpoint: undefined, until, legacyAvailable: false,
    }),
  ]
  assert.deepEqual(
    finalizableNativePlans(plans, new Set(['claude', 'codex'])).map(plan => plan.provider),
    ['codex'],
  )
  assert.deepEqual(
    finalizableNativePlans(plans, new Set(['claude', 'codex', 'cc-switch']))
      .map(plan => plan.provider),
    ['claude', 'codex'],
  )
  const state = emptyCollectorState()
  const ready = finalizableNativePlans(plans, new Set(['codex']))
  await finalizeNativeProgress({
    plans: ready, state, deviceId: 'd1', until,
    commit: async () => {}, save: async () => {},
  })
  assert.equal(getCheckpoint(state, 'd1', 'claude'), undefined)
  assert.equal(getCheckpoint(state, 'd1', 'codex'), until)
})

test('failed multi-chunk ingest never starts checkpoint finalization', async () => {
  let requests = 0
  let finalized = false
  const fetchImpl: typeof fetch = async () => {
    requests += 1
    if (requests === 1) {
      return new Response(JSON.stringify({
        ok: true, created: 500, updated: 0, unchanged: 0,
        total: 500, inserted: 500,
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 503 })
  }
  const client = new ServerClient('https://example.test', '', { fetchImpl })
  const records = Array.from({ length: 501 }, (_, index) => ({
    provider: 'claude', model: 'model', input_tokens: 1, output_tokens: 1,
    cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
    cost_usd: 0, timestamp: until, source_file: 'fixture', dedup_key: `key:${index}`,
  }))
  await assert.rejects(() => finalizeAfterSuccessfulIngest(
    () => client.ingest('d1', records),
    async () => { finalized = true },
  ), /HTTP 503/)
  assert.equal(requests, 2)
  assert.equal(finalized, false)
})
