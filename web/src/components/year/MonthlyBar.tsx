import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { MonthStatsRow } from '@tokember/contracts/stats'
import type { YearMetric } from '../../analytics/date-range'
import {
  annualMetricValue, formatAnnualMetric, YEAR_METRIC_LABELS,
} from '../../analytics/year-metric'

const MONTH_LABELS: Record<string, string> = {
  '01': '1月', '02': '2月', '03': '3月', '04': '4月', '05': '5月', '06': '6月',
  '07': '7月', '08': '8月', '09': '9月', '10': '10月', '11': '11月', '12': '12月',
}

export function MonthlyBar({ data, metric }: { data: MonthStatsRow[]; metric: YearMetric }) {
  const chartData = data.map(d => {
    const mm = d.month.slice(-2)
    return { label: MONTH_LABELS[mm] ?? d.month, value: annualMetricValue(d, metric) }
  })
  const max = chartData.reduce((current, row) => Math.max(current, row.value), 0)

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-4">月度{YEAR_METRIC_LABELS[metric]}</h2>
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
              formatter={(value: number) => [formatAnnualMetric(value, metric), YEAR_METRIC_LABELS[metric]]}
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
