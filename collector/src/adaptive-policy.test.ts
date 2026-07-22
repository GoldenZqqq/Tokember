import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideAdmission,
  emptyAdaptiveState,
  promisedIntervalMinutes,
  recordFailure,
  recordSuccess,
} from './adaptive-policy.js'

const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minutes))

test('first state is immediately due and active promises one minute', () => {
  const state = emptyAdaptiveState(at(0))
  assert.deepEqual(decideAdmission(state, at(0)), { run: true, reason: 'due' })
  assert.equal(promisedIntervalMinutes(state), 1)
})

test('not-due ticks skip without network admission, while force and probe activity run', () => {
  const state = recordSuccess(emptyAdaptiveState(at(0)), { activityObserved: true, emitted: 1 }, at(0))
  assert.deepEqual(decideAdmission(state, at(0)), { run: false, reason: 'not_due' })
  assert.deepEqual(decideAdmission(state, at(0), { force: true }), { run: true, reason: 'force' })
  assert.deepEqual(decideAdmission(state, at(0), { activityObserved: true }), { run: true, reason: 'activity' })
})

test('clock rollback becomes due instead of waiting for a future timestamp', () => {
  const state = recordSuccess(
    emptyAdaptiveState(at(10)), { activityObserved: false, emitted: 0 }, at(10),
  )
  assert.deepEqual(decideAdmission(state, at(0)), { run: true, reason: 'due' })
})

test('empty successes transition active to recent to idle with bounded intervals', () => {
  let state = emptyAdaptiveState(at(0))
  state = recordSuccess(state, { activityObserved: false, emitted: 0 }, at(0))
  state = recordSuccess(state, { activityObserved: false, emitted: 0 }, at(1))
  assert.equal(state.band, 'active')
  state = recordSuccess(state, { activityObserved: false, emitted: 0 }, at(2))
  assert.equal(state.band, 'recent')
  assert.equal(promisedIntervalMinutes(state), 3)
  for (const minute of [3, 4, 5, 6, 7]) {
    state = recordSuccess(state, { activityObserved: false, emitted: 0 }, at(minute))
  }
  assert.equal(state.band, 'idle')
  assert.equal(promisedIntervalMinutes(state), 15)
})

test('activity or emitted records immediately return to active and clear empties', () => {
  let state = emptyAdaptiveState(at(0))
  for (const minute of [0, 1, 2]) {
    state = recordSuccess(state, { activityObserved: false, emitted: 0 }, at(minute))
  }
  assert.equal(state.band, 'recent')
  state = recordSuccess(state, { activityObserved: false, emitted: 1 }, at(10))
  assert.equal(state.band, 'active')
  assert.equal(state.consecutive_empty, 0)
  assert.equal(state.consecutive_failures, 0)
})

test('failures use capped exponential schedule and success resets the band', () => {
  let state = emptyAdaptiveState(at(0))
  for (const [minute, backoff] of [[0, 2], [2, 5], [7, 15], [22, 30], [52, 30]] as const) {
    state = recordFailure(state, at(minute))
    assert.equal(promisedIntervalMinutes(state), backoff)
  }
  state = recordSuccess(state, { activityObserved: false, emitted: 0 }, at(82))
  assert.equal(state.band, 'recent')
  assert.equal(state.consecutive_failures, 0)
})

test('invalid policy backoff is rejected', () => {
  assert.throws(() => recordFailure(emptyAdaptiveState(), new Date(), { failureBackoffMinutes: [] }), /positive integers/)
})
