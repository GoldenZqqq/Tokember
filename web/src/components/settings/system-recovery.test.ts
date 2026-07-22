import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import type { RecoveryStatus } from '../../admin/types'
import { RecoverySection } from './SystemPanel'

test('recovery section renders safe operational status without internal detail', () => {
  const recovery: RecoveryStatus = {
    state: 'drill_failed',
    last_attempt_at: '2026-07-18T11:00:00.000Z',
    last_success_at: '2026-07-18T10:00:00.000Z',
    last_failure_at: '2026-07-18T11:00:00.000Z',
    age_seconds: 7_200,
    backup_bytes: 55_947_264,
    schema_version: 9,
    integrity: 'passed',
    error_code: 'smoke',
    drill: {
      state: 'failed',
      last_attempt_at: '2026-07-18T11:00:00.000Z',
      last_success_at: '2026-07-18T10:00:00.000Z',
      duration_ms: 1_234,
    },
  }
  const html = renderToStaticMarkup(createElement(RecoverySection, { recovery }))
  assert.match(html, /数据库恢复/)
  assert.match(html, /演练失败/)
  assert.match(html, /53\.4 MB/)
  assert.match(html, /Schema/)
  assert.match(html, /1,234 ms/)
  assert.doesNotMatch(html, /smoke|status\.json|tokember\.db|raw error/i)
})
