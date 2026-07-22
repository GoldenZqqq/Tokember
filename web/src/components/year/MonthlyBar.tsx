import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { MonthStatsRow } from '@tokember/contracts/stats'
import type { YearMetric } from '../../analytics/date-range'
import {
  annualMetricValue, formatAnnualMetric, yearMetricLabelKey,
} from '../../analytics/year-metric'
import { useT } from '../../i18n'

const MONTH_KEYS = [
  'month.m01', 'month.m02', 'month.m03', 'month.m04', 'month.m05', 'month.m06',
  'month.m07', 'month.m08', 'month.m09', 'month.m10', 'month.m11', 'month.m12',
] as const

export function MonthlyBar({ data, metric }: { data: MonthStatsRow[]; metric: YearMetric }) {
  const t = useT()
  const metricLabel = t(yearMetricLabelKey(metric))
  const chartData = data.map(d => {
    const mm = Number(d.month.slice(-2)) - 1
    return {
      label: MONTH_KEYS[mm] ? t(MONTH_KEYS[mm]) : d.month,
      value: annualMetricValue(d, metric),
    }
  })
  const max = chartData.reduce((current, row) => Math.max(current, row.value), 0)

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-4">{t('year.monthly', { metric: metricLabel })}</h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#71717a', fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#71717a', fontSize: 12 }}
              tickFormatter={value => formatAnnualMetric(Number(value), metric)}
            />
            <Tooltip
              cursor={{ fill: 'rgba(249,115,22,0.08)' }}
              contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}
              labelStyle={{ color: '#a1a1aa' }}
              itemStyle={{ color: '#e4e4e7' }}
              formatter={(value: number) => [formatAnnualMetric(value, metric), metricLabel]}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {chartData.map((row, index) => (
                <Cell key={index} fill={max > 0 && row.value === max ? '#f97316' : '#f97316aa'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
