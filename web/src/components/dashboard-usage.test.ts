import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CostCoverage } from '@tokember/contracts/stats'
import type { Stats } from '../dashboard-stats'
import { withLocale } from '../test-utils'
import { DailyChart } from './DailyChart'
import { Overview } from './Overview'
import { ComparisonPanel } from './ComparisonPanel'
import { AttributionBreakdown } from './AttributionBreakdown'
import { AnalyticsControls } from './AnalyticsControls'
import { DashboardContent } from './DashboardContent'

const completeCoverage: CostCoverage = {
  priced_calls: 1,
  unpriced_calls: 0,
  priced_tokens: 100,
  unpriced_tokens: 0,
  call_ratio: 1,
  token_ratio: 1,
}

function createStats(pricingCoverage: CostCoverage): Stats {
  return {
    snapshot: {
      since: '2026-07-17T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
      timezone_offset: -480, max_record_id: 1,
    },
    total_cost: 1,
    total_input_tokens: 40,
    total_output_tokens: 60,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    real_total_tokens: 100,
    total_requests: 1,
    pricing_coverage: pricingCoverage,
    comparison: null,
    daily: [],
    by_provider: [],
    by_model: [],
    by_device: [],
    attribution: [],
    project_options: [],
    by_project: [],
    by_session: [],
  }
}

function render(node: React.ReactElement) {
  return renderToStaticMarkup(withLocale(node))
}

test('daily chart labels cost and token usage together', () => {
  const html = render(createElement(DailyChart, { data: [], isToday: true }))

  assert.match(html, /Today usage trend/)
  assert.match(html, /Cost/)
  assert.match(html, /Tokens/)
  assert.doesNotMatch(html, /今日花费趋势/)
})

test('analytics controls hide the comparison row while preserving other filters', () => {
  const filters = {
    device: 'all', project: 'all', range: 'today' as const, comparison: 'none' as const,
  }
  const props = {
    filters,
    projects: [],
    onProject: () => {},
    onCustomRange: () => {},
  }

  assert.equal(render(createElement(AnalyticsControls, props)), '')
  const customHtml = render(createElement(AnalyticsControls, {
    ...props,
    filters: {
      ...filters,
      range: 'custom' as const,
      since: '2026-07-17T00:00:00.000Z',
      until: '2026-07-18T00:00:00.000Z',
    },
  }))
  const projectHtml = render(createElement(AnalyticsControls, {
    ...props,
    projects: [{ group_id: 1, name: 'Project A' }],
  }))

  assert.match(customHtml, /Start \(local time\)/)
  assert.match(projectHtml, /Project A/)
  assert.doesNotMatch(`${customHtml}${projectHtml}`, /Period comparison|Previous period|上一周期/)
})

test('project and session attribution renders as analysis without public warnings', () => {
  const stats = createStats(completeCoverage)
  stats.attribution = [{
    status: 'captured', records: 1, requests: 2, real_total_tokens: 100, cost: 1,
  }]
  stats.by_project = [{
    group_id: 1, name: 'Project A', members: 1,
    requests: 2, real_total_tokens: 100, cost: 1,
  }]
  stats.by_session = [{
    session_id: `ses_v1_${'a'.repeat(43)}`, project_group_id: 1,
    project_name: 'Project A', requests: 2, real_total_tokens: 100, cost: 1,
  }]
  const html = render(createElement(AttributionBreakdown, {
    stats, onAudit: () => {},
  }))
  assert.match(html, /Projects & sessions|Project A/)
  assert.doesNotMatch(html, /Cost coverage|unpriced|budget|source health|成本覆盖|尚未计价/)
})

test('dashboard labels incomplete cost without rendering public coverage copy', () => {
  const completeHtml = render(createElement(Overview, {
    stats: createStats(completeCoverage),
  }))
  const incompleteHtml = render(createElement(Overview, {
    stats: createStats({
      ...completeCoverage,
      unpriced_calls: 1,
      unpriced_tokens: 50,
      call_ratio: 0.5,
      token_ratio: 0.5,
    }),
  }))

  assert.match(completeHtml, /Total cost/)
  assert.match(incompleteHtml, /Known cost/)
  assert.doesNotMatch(completeHtml, /Cost coverage|尚未计价|成本覆盖/)
  assert.doesNotMatch(incompleteHtml, /Cost coverage|尚未计价|成本覆盖/)
})

test('public analytics controls keep useful filters without period comparison', () => {
  const html = render(createElement(AnalyticsControls, {
    filters: { device: 'all', project: 'all', range: 7, comparison: 'previous-month' },
    projects: [{ group_id: 1, name: 'Project A' }],
    onProject: () => {},
    onCustomRange: () => {},
  }))

  assert.match(html, /Project/)
  assert.doesNotMatch(html, /Period comparison|Previous period|Same days last week|Same days last month|Same days last year|周期比较|上一周期/)
})

test('public dashboard omits comparison panel even when comparison data exists', () => {
  const current = createStats(completeCoverage)
  const previous = { ...current, comparison: undefined }
  const html = render(createElement(DashboardContent, {
    stats: {
      ...current,
      comparison: { mode: 'previous-period', label: 'Previous period', stats: previous },
    },
    range: 7,
    onAudit: () => {},
  }))

  assert.doesNotMatch(html, /Period comparison|Previous period|Same days last week|周期比较|上一周期/)
})

test('comparison renders explicit zero-base states without non-finite values', () => {
  const current = {
    ...createStats(completeCoverage),
    by_provider: [{
      provider: 'codex', cost: 1, requests: 1, real_total_tokens: 100,
    }],
  }
  const previous = {
    ...current, total_cost: 0, real_total_tokens: 0, total_requests: 0,
    by_provider: [{
      provider: 'codex', cost: 0, requests: 0, real_total_tokens: 0,
    }],
    comparison: undefined,
  }
  const html = render(createElement(ComparisonPanel, {
    stats: {
      ...current,
      comparison: { mode: 'previous-period', label: 'Previous period', stats: previous },
    },
  }))
  assert.match(html, /Period comparison/)
  assert.match(html, /Codex/)
  assert.doesNotMatch(html, />codex</)
  assert.match(html, /New/)
  assert.match(html, /Δ \+\$1\.00/)
  assert.match(html, /Prev \$0\.000/)
  assert.match(html, /Diff \+\$1\.000/)
  assert.doesNotMatch(html, /Infinity|NaN/)
})
