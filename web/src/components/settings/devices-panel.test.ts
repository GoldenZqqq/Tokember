import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DeviceSummary } from '../../admin/types'
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
      error_summary: '上传失败', finished_at: '2026-07-17T01:00:00.000Z',
      consecutive_failures: 2,
    }],
  },
}

test('device card explains dynamic health and source-level failures', () => {
  const html = renderToStaticMarkup(createElement(DeviceCard, { device }))

  assert.match(html, /异常/)
  assert.match(html, /每 30 分钟/)
  assert.match(html, /75 分钟无完整运行后判定离线/)
  assert.match(html, /Windows · x64 · desktop-1/)
  assert.match(html, /Gemini/)
  assert.match(html, /工具来源/)
  assert.match(html, /采集失败|上传失败/)
  assert.match(html, /发现 \/ 扫描/)
  assert.match(html, /未知/)
})

test('one-time device token is explicit and contains no public warning copy', () => {
  const html = renderToStaticMarkup(createElement(OneTimeToken, {
    token: 'tkdc_abcdefghijkl_abcdefghijklmnopqrstuvwxyz123456', onClear: () => {},
  }))
  assert.match(html, /仅显示一次|不会再次显示/)
  assert.match(html, /tkdc_abcdefghijkl/)
  assert.doesNotMatch(html, /成本覆盖|尚未计价|预算|来源健康/)
})
