import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAuthoritativeSourceFilter } from './source-authority.js'

test('Antigravity authority computes one snapshot-bound legacy boundary per device', () => {
  const sql = buildAuthoritativeSourceFilter('u', 42)

  assert.equal(sql.match(/LIKE 'cb:%'/g)?.length, 1)
  assert.match(sql, /GROUP BY device_id/)
  assert.match(sql, /antigravity_legacy\.id <= 42/)
})
