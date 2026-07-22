import assert from 'node:assert/strict'
import test from 'node:test'
import { CollectionObserver } from './types.js'

test('collection observer separates discovered work from scanned work', () => {
  const observer = new CollectionObserver()
  observer.discover(4)
  observer.scan('2026-07-17T00:00:00.000Z')
  observer.scan('2026-07-17T01:00:00.000Z')
  observer.scan('invalid')

  assert.deepEqual(observer.snapshot(), {
    discovered: 4,
    scanned: 3,
    watermark_at: '2026-07-17T01:00:00.000Z',
  })
})
