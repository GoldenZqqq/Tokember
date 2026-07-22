import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MonthStatsRow, YearStatsRow } from '@tokember/contracts/stats'
import { MonthlyBar } from './MonthlyBar'
import { YearHeatmap } from './YearHeatmap'

const coverage = {
  priced_calls: 2, unpriced_calls: 0, priced_tokens: 100, unpriced_tokens: 0,
  call_ratio: 1, token_ratio: 1,
}
const aggregate = {
  calls: 2, real_total_tokens: 100, cost: 1, pricing_coverage: coverage,
  since: '2026-01-01T00:00:00.000Z', until: '2026-01-02T00:00:00.000Z',
}

test('annual charts switch to Server-provided Tokens and Calls metrics', () => {
  const daily: YearStatsRow[] = [{ ...aggregate, date: '2026-01-01' }]
  const monthly: MonthStatsRow[] = [{ ...aggregate, month: '2026-01' }]
  const heatmap = renderToStaticMarkup(createElement(YearHeatmap, {
    year: 2026, daily, metric: 'tokens',
  }))
  const bars = renderToStaticMarkup(createElement(MonthlyBar, {
    data: monthly, metric: 'calls',
  }))
  assert.match(heatmap, /真实 Tokens热力图/)
  assert.match(bars, /月度Calls/)
  assert.doesNotMatch(`${heatmap}${bars}`, /成本覆盖|尚未计价/)
})
