import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from './api-client'
import {
  beginResource, failResource, initialResource, succeedResource,
} from './resource-state'

test('same-key refresh failure retains successful data as stale', () => {
  const ready = succeedResource(initialResource<number>(), 'today', 42, 100)
  const refreshing = beginResource(ready, 'today')
  assert.equal(refreshing.status, 'refreshing')
  const stale = failResource(refreshing, 'today', new ApiError('network', 'offline'))
  assert.equal(stale.status, 'stale')
  assert.equal(stale.data, 42)
  assert.equal(stale.updatedAt, 100)
})

test('new key never presents data from the previous key', () => {
  const ready = succeedResource(initialResource<number>(), 'today', 42, 100)
  const next = beginResource(ready, '7')
  assert.equal(next.status, 'loading')
  assert.equal(next.data, null)
  const failed = failResource(next, '7', new ApiError('server', 'failed'))
  assert.equal(failed.status, 'error')
})

test('successful retry clears stale error', () => {
  const ready = succeedResource(initialResource<number>(), 'today', 42, 100)
  const stale = failResource(beginResource(ready, 'today'), 'today',
    new ApiError('network', 'offline'))
  const recovered = succeedResource(stale, 'today', 43, 200)
  assert.equal(recovered.status, 'ready')
  assert.equal(recovered.error, null)
  assert.equal(recovered.data, 43)
})
