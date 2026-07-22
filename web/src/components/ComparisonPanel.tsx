import { useState } from 'react'
import type { Stats, StatsAggregateView } from '../dashboard-stats'
import { numericDelta } from '../analytics/date-range'
import { modelDisplayName } from '../model-display'
import { providerDisplayName } from '../provider-display'

type Dimension = 'provider' | 'model' | 'device'

interface DimensionRow {
  key: string
  label: string
  current: { cost: number; tokens: number; calls: number }
  previous: { cost: number; tokens: number; calls: number }
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(value)
}

function rateLabel(current: number, previous: number): string {
  const delta = numericDelta(current, previous)
  if (delta.state === 'new') return '新增'
  const rate = (delta.rate ?? 0) * 100
  return `${rate > 0 ? '+' : ''}${rate.toFixed(1)}%`
}

function signedDifference(
  current: number,
  previous: number,
  format: (value: number) => string,
): string {
  const difference = current - previous
  const sign = difference > 0 ? '+' : difference < 0 ? '-' : ''
  return `${sign}${format(Math.abs(difference))}`
}

function DeltaValue({ current, previous }: { current: number; previous: number }) {
  const difference = current - previous
  const positive = difference > 0
  return <span className={difference === 0
    ? 'text-zinc-500' : positive ? 'text-orange-300' : 'text-emerald-300'}>
    {rateLabel(current, previous)}
  </span>
}

function MetricComparison({
  label, current, previous, format,
}: {
  label: string
  current: number
  previous: number
  format: (value: number) => string
}) {
  return <div className="min-w-0 p-4">
    <p className="text-xs text-zinc-500">{label}</p>
    <p className="mt-2 text-lg font-semibold tabular-nums text-zinc-100">{format(current)}</p>
    <p className="mt-1 text-xs tabular-nums text-zinc-500">
      对比 {format(previous)} · 差额 {signedDifference(current, previous, format)} ·{' '}
      <DeltaValue current={current} previous={previous} />
    </p>
  </div>
}

function CoverageComparison({ current, previous }: { current: number; previous: number }) {
  const points = (current - previous) * 100
  return <div className="min-w-0 p-4">
    <p className="text-xs text-zinc-500">Token 计价覆盖率</p>
    <p className="mt-2 text-lg font-semibold tabular-nums text-zinc-100">
      {(current * 100).toFixed(1)}%
    </p>
    <p className="mt-1 text-xs tabular-nums text-zinc-500">
      对比 {(previous * 100).toFixed(1)}% · {points > 0 ? '+' : ''}{points.toFixed(1)} pp
    </p>
  </div>
}

function emptyValues() {
  return { cost: 0, tokens: 0, calls: 0 }
}

function dimensionEntries(view: StatsAggregateView, dimension: Dimension) {
  if (dimension === 'provider') return view.by_provider.map(row => ({
    key: row.provider,
    label: providerDisplayName(row.provider),
    values: { cost: row.cost, tokens: row.real_total_tokens, calls: row.requests },
  }))
  if (dimension === 'model') return view.by_model.map(row => ({
    key: `${row.provider}\u0000${row.model}`,
    label: `${modelDisplayName(row.model)} · ${providerDisplayName(row.provider)}`,
    values: { cost: row.cost, tokens: row.real_total_tokens, calls: row.requests },
  }))
  return view.by_device.map(row => ({
    key: `${row.device}\u0000${row.provider}`,
    label: `${row.device} · ${providerDisplayName(row.provider)}`,
    values: { cost: row.cost, tokens: row.real_total_tokens, calls: row.requests },
  }))
}

function comparisonRows(
  current: StatsAggregateView,
  previous: StatsAggregateView,
  dimension: Dimension,
): DimensionRow[] {
  const currentRows = new Map(dimensionEntries(current, dimension).map(row => [row.key, row]))
  const previousRows = new Map(dimensionEntries(previous, dimension).map(row => [row.key, row]))
  const keys = new Set([...currentRows.keys(), ...previousRows.keys()])
  return [...keys].map(key => ({
    key, label: currentRows.get(key)?.label ?? previousRows.get(key)!.label,
    current: currentRows.get(key)?.values ?? emptyValues(),
    previous: previousRows.get(key)?.values ?? emptyValues(),
  })).sort((left, right) => (
    right.current.cost + right.previous.cost - left.current.cost - left.previous.cost
  ))
}

function DimensionCell({
  current, previous, kind,
}: {
  current: number
  previous: number
  kind: 'cost' | 'tokens' | 'calls'
}) {
  const format = kind === 'cost'
    ? (value: number) => `$${value.toFixed(3)}`
    : formatCompact
  return <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
    <span className="block">{format(current)}</span>
    <span className="mt-0.5 block text-[10px] text-zinc-600">前 {format(previous)}</span>
    <span className="mt-0.5 block text-[10px]">
      差 {signedDifference(current, previous, format)} ·{' '}
      <DeltaValue current={current} previous={previous} />
    </span>
  </td>
}

function DimensionTable({ rows }: { rows: DimensionRow[] }) {
  return <div className="overflow-x-auto border-t border-white/[0.06]">
    <table className="min-w-[38rem] w-full text-xs">
      <thead className="text-zinc-600"><tr>
        <th className="px-3 py-2 text-left font-medium">维度</th>
        <th className="px-3 py-2 text-right font-medium">花费</th>
        <th className="px-3 py-2 text-right font-medium">Tokens</th>
        <th className="px-3 py-2 text-right font-medium">Calls</th>
      </tr></thead>
      <tbody className="divide-y divide-white/[0.05]">{rows.slice(0, 12).map(row => <tr key={row.key}>
        <td className="max-w-72 break-words px-3 py-2.5 font-mono text-zinc-300">{row.label}</td>
        <DimensionCell current={row.current.cost} previous={row.previous.cost} kind="cost" />
        <DimensionCell current={row.current.tokens} previous={row.previous.tokens} kind="tokens" />
        <DimensionCell current={row.current.calls} previous={row.previous.calls} kind="calls" />
      </tr>)}</tbody>
    </table>
  </div>
}

export function ComparisonPanel({ stats }: { stats: Stats }) {
  const [dimension, setDimension] = useState<Dimension>('provider')
  const comparison = stats.comparison
  if (!comparison) return null
  const previous = comparison.stats
  const rows = comparisonRows(stats, previous, dimension)
  return <section className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.015]">
    <header className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div><h2 className="text-sm font-semibold text-zinc-200">周期比较</h2>
        <p className="mt-1 text-xs text-zinc-600">当前窗口 vs {comparison.label}</p></div>
      <div className="flex overflow-hidden rounded-lg border border-zinc-800">
        {([['provider', '来源'], ['model', '模型'], ['device', '设备']] as const).map(([value, label]) => <button
          type="button" key={value} aria-pressed={dimension === value}
          onClick={() => setDimension(value)}
          className={`px-3 py-1.5 text-xs ${dimension === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
          {label}
        </button>)}
      </div>
    </header>
    <div className="grid grid-cols-2 divide-x divide-y divide-white/[0.06] lg:grid-cols-4 lg:divide-y-0">
      <MetricComparison label="已知花费" current={stats.total_cost}
        previous={previous.total_cost} format={value => `$${value.toFixed(2)}`} />
      <MetricComparison label="真实 Tokens" current={stats.real_total_tokens}
        previous={previous.real_total_tokens} format={formatCompact} />
      <MetricComparison label="Calls" current={stats.total_requests}
        previous={previous.total_requests} format={formatCompact} />
      <CoverageComparison current={stats.pricing_coverage.token_ratio}
        previous={previous.pricing_coverage.token_ratio} />
    </div>
    <DimensionTable rows={rows} />
  </section>
}
