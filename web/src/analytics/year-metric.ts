import type { MonthStatsRow, YearStatsRow } from '@tokember/contracts/stats'
import type { YearMetric } from './date-range'

export type AnnualAggregate = YearStatsRow | MonthStatsRow

/** English defaults; UI should prefer t('yearMetric.*') when rendering. */
export const YEAR_METRIC_LABELS: Record<YearMetric, string> = {
  cost: 'Cost', tokens: 'Real tokens', calls: 'Calls',
}

export function yearMetricLabelKey(metric: YearMetric): `yearMetric.${YearMetric}` {
  return `yearMetric.${metric}`
}

export function annualMetricValue(row: AnnualAggregate, metric: YearMetric): number {
  if (metric === 'cost') return row.cost
  if (metric === 'tokens') return row.real_total_tokens
  return row.calls
}

export function formatAnnualMetric(value: number, metric: YearMetric): string {
  if (metric === 'cost') return `$${value.toFixed(2)}`
  return value.toLocaleString('zh-CN')
}
