import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ccSwitchRequestCountColumn,
  ccSwitchRollupToRecord,
} from './cc-switch.js'

test('cc-switch rollups preserve authoritative request counts', () => {
  const record = ccSwitchRollupToRecord({
    date: '2026-07-16',
    app_type: 'codex',
    model: 'gpt-test',
    provider_id: 'provider-1',
    request_count: 87,
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 40,
    cache_creation_tokens: 0,
    total_cost_usd: '1.25',
  })
  assert.equal(record.request_count, 87)
  assert.equal(record.input_tokens, 100)
  assert.equal(record.cache_read_tokens, 40)
  assert.equal(record.cost_usd, 1.25)
})

test('cc-switch request count projection supports older schemas', () => {
  assert.equal(ccSwitchRequestCountColumn(['date', 'request_count']), 'request_count')
  assert.equal(ccSwitchRequestCountColumn(['date']), '1 AS request_count')
})
