import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchSourceRecords } from './source-data'

const snapshot = {
  since: '2026-07-17T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
  timezone_offset: -480, max_record_id: 9,
}

test('public source records omit admin-only visibility and keep snapshot filters', async () => {
  const original = globalThis.fetch
  let requested = ''
  globalThis.fetch = input => {
    requested = String(input)
    return Promise.resolve(Response.json({
      snapshot, visibility: 'authoritative', rows: [], next_cursor: null,
    }))
  }
  try {
    await fetchSourceRecords({
      api: '',
      filters: {
        ...snapshot, snapshot_max_id: snapshot.max_record_id,
        provider: 'codex', visibility: 'authoritative',
      },
    })
    const params = new URL(requested, 'http://local').searchParams
    assert.equal(params.get('visibility'), null)
    assert.equal(params.get('provider'), 'codex')
    assert.equal(params.get('snapshot_max_id'), '9')
    assert.equal(params.get('limit'), '50')
  } finally {
    globalThis.fetch = original
  }
})
