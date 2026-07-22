import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DeviceSummary } from '../../admin/types'
import { withLocale } from '../../test-utils'
import { DeviceCard } from './DevicesPanel'
import { OneTimeToken } from './DeviceCredentialPanel'

const device: DeviceSummary = {
  id: 'windows-1', name: 'Windows Device', created_at: '2026-07-17 00:00:00',
  last_seen_at: '2026-07-17T01:00:00.000Z', prev_seen_at: null,
  platform: 'windows', architecture: 'x64', hostname: 'desktop-1',
  record_count: 8, last_record_at: '2026-07-17T00:58:00.000Z',
  collector: {
    status: 'degraded', online: true, freshness_threshold_minutes: 75,
    last_successful_at: '2026-07-17T00:30:00.000Z',
    latest_run: {
      run_id: 'run-1', status: 'partial', started_at: '2026-07-17T00:59:00.000Z',
      finished_at: '2026-07-17T01:00:00.000Z', duration_ms: 1000,
      schedule_interval_minutes: 30, emitted: 2, accepted: null,
      unchanged: null, error_summary: 'gemini failed',
    },
    sources: [{
      source: 'gemini', status: 'upload_failed', discovered: 7, scanned: 6,
      emitted: 2, accepted: null, unchanged: null, watermark_at: null,
      last_usage_at: '2026-07-17T00:58:00.000Z', duration_ms: 900,
      error_summary: 'upload failed', finished_at: '2026-07-17T01:00:00.000Z',
      consecutive_failures: 2,
    }],
  },
}

test('device card explains dynamic health and source-level failures', () => {
  const html = renderToStaticMarkup(withLocale(createElement(DeviceCard, { device })))

  assert.match(html, /Degraded/)
  assert.match(html, /Every 30 minutes/)
  assert.match(html, /offline after 75 min without a complete run/)
  assert.match(html, /Windows · x64 · desktop-1/)
  assert.match(html, /Gemini/)
  assert.match(html, /Tool sources/)
  assert.match(html, /Collection failed|Upload failed/)
  assert.match(html, /Discovered \/ scanned/)
  assert.match(html, /Unknown/)
})

test('one-time device token is explicit and contains no public warning copy', () => {
  const html = renderToStaticMarkup(withLocale(createElement(OneTimeToken, {
    token: 'tkdc_abcdefghijkl_abcdefghijklmnopqrstuvwxyz123456', onClear: () => {},
  })))
  assert.match(html, /will not be shown again|Copy now/)
  assert.match(html, /tkdc_abcdefghijkl/)
  assert.doesNotMatch(html, /成本覆盖|尚未计价|预算|来源健康/)
})
