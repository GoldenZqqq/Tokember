import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MonthStatsRow, YearStatsRow } from '@tokember/contracts/stats'
import { withLocale } from '../../test-utils'
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
  const heatmap = renderToStaticMarkup(withLocale(createElement(YearHeatmap, {
    year: 2026, daily, metric: 'tokens',
  })))
  const bars = renderToStaticMarkup(withLocale(createElement(MonthlyBar, {
    data: monthly, metric: 'calls',
  })))
  assert.match(heatmap, /2026 Real tokens heatmap/)
  assert.match(bars, /Monthly Calls/)
  assert.doesNotMatch(`${heatmap}${bars}`, /成本覆盖|尚未计价|Cost coverage/)
})
