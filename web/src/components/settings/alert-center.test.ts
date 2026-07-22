import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AlertCenterResponse } from '@tokember/contracts/alerts'
import { withLocale } from '../../test-utils'
import { AlertCenterContent, evidenceLines } from './AlertCenterPanel'
import { SETTINGS_MENU } from './SettingsSidebar'

const center: AlertCenterResponse = {
  webhook_configured: false,
  rules: [{
    id: 1, name: 'Daily budget', kind: 'budget', device_id: null, provider: null,
    timezone: 'Asia/Shanghai', enabled: true, cooldown_minutes: 60,
    notify_webhook: true, config: { period: 'day', metric: 'cost', limit: 10 },
    created_at: '2026-07-17T00:00:00.000Z', updated_at: '2026-07-17T00:00:00.000Z',
    evaluation: {
      rule_id: 1, evaluated_at: '2026-07-17T04:00:00.000Z',
      status: 'triggered', reason: 'Budget reached 80%', evidence: null,
    },
  }],
  events: [{
    id: 1, rule_id: 1, rule_name: 'Daily budget', kind: 'budget',
    device_id: null, provider: null, dedup_key: 'rule:1:budget',
    status: 'active', severity: 'warning',
    first_triggered_at: '2026-07-17T03:00:00.000Z',
    last_triggered_at: '2026-07-17T04:00:00.000Z', recovered_at: null,
    acknowledged_at: null, cooldown_until: '2026-07-17T05:00:00.000Z',
    notification_status: 'not_configured',
    evidence: {
      kind: 'budget', metric: 'cost', period: 'day',
      window: { since: '2026-07-16T16:00:00.000Z', until: '2026-07-17T16:00:00.000Z' },
      used: 8, limit: 10, ratio: 0.8, forecast: 16,
      forecast_incomplete: true, threshold: 0.8,
    },
  }],
}

test('alert center renders explainable admin-only evidence and enabled menu', () => {
  const html = renderToStaticMarkup(withLocale(createElement(AlertCenterContent, {
    data: { center, devices: [] }, busy: false,
    onEdit: () => {}, onToggle: () => {}, onCreate: () => {}, onAcknowledge: () => {},
  })))
  assert.match(html, /Daily budget/)
  assert.match(html, /Incomplete cost forecast/)
  assert.match(html, /Acknowledge/)
  assert.match(html, /Not configured/)
  assert.doesNotMatch(html, /secret|webhook.*https:/i)
  assert.equal(SETTINGS_MENU.find(item => item.id === 'alerts')?.enabled, true)
  assert.match(evidenceLines(center.events[0]).join(' '), /Forecast \$16\.00/)
})
