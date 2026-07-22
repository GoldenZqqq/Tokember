import { useEffect } from 'react'
import type { YearStatsResponse } from '@tokember/contracts/stats'
import type { DeviceOption } from '../../dashboard-stats'
import type { ResourceState } from '../../data/resource-state'
import { hasIncompleteCost } from '../../cost-coverage'
import {
  yearFiltersFromHash, yearHash, type YearFilters, type YearMetric,
} from '../../analytics/date-range'
import {
  annualMetricValue, formatAnnualMetric, YEAR_METRIC_LABELS,
} from '../../analytics/year-metric'
import { useYearData } from '../../year-data'
import { DeviceSelector } from '../DeviceSelector'
import { ReadFeedback } from '../ReadFeedback'
import { ResourceView } from '../ResourceView'
import { MonthlyBar } from './MonthlyBar'
import { YearHeatmap } from './YearHeatmap'

const API = import.meta.env.VITE_API_URL || ''

function selectedTotal(stats: YearStatsResponse, metric: YearMetric): number {
  if (metric === 'cost') return stats.totals.total_cost
  if (metric === 'tokens') return stats.totals.real_total_tokens
  return stats.totals.total_calls
}

function peakFor(stats: YearStatsResponse, metric: YearMetric) {
  return stats.daily.reduce<{ date: string; value: number }>((peak, row) => {
    const value = annualMetricValue(row, metric)
    return value > peak.value ? { date: row.date, value } : peak
  }, { date: '', value: 0 })
}

function yearSummaryCards(stats: YearStatsResponse, metric: YearMetric) {
  const peak = peakFor(stats, metric)
  const incomplete = hasIncompleteCost(stats.totals.pricing_coverage)
  const secondary = metric === 'cost'
    ? { label: '真实 Tokens', value: stats.totals.real_total_tokens.toLocaleString('zh-CN') }
    : { label: incomplete ? '全年已知花费' : '全年花费', value: `$${stats.totals.total_cost.toFixed(2)}` }
  return [
    {
      label: metric === 'cost' && incomplete ? '全年已知花费' : `全年${YEAR_METRIC_LABELS[metric]}`,
      value: formatAnnualMetric(selectedTotal(stats, metric), metric), color: 'text-orange-400',
    },
    { label: '活跃天数', value: `${stats.totals.active_days} 天`, color: 'text-blue-400' },
    {
      label: `${YEAR_METRIC_LABELS[metric]}峰值日`,
      value: peak.date ? formatAnnualMetric(peak.value, metric) : '—',
      sub: peak.date || undefined, color: 'text-emerald-400',
    },
    { ...secondary, color: 'text-purple-400' },
  ]
}

function YearHeader({ onBack }: { onBack: () => void }) {
  return <header className="mb-5 flex items-center justify-between border-b border-white/[0.06] pb-5">
    <button onClick={onBack} className="flex items-center gap-3 text-left">
      <img src="/icon-192.png" alt="" className="h-10 w-10 rounded-xl" />
      <span><span className="block whitespace-nowrap text-base font-bold text-zinc-100 sm:text-lg">Tokember 年度</span>
        <span className="block text-xs text-zinc-600">Annual Report</span></span>
    </button>
    <button onClick={onBack}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
      aria-label="返回仪表盘">
      <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
    </button>
  </header>
}

function MetricTabs({ value, onChange }: { value: YearMetric; onChange: (value: YearMetric) => void }) {
  return <div className="flex overflow-hidden rounded-lg border border-zinc-800" aria-label="年度指标">
    {(['cost', 'tokens', 'calls'] as const).map(metric => <button type="button" key={metric}
      aria-pressed={value === metric} onClick={() => onChange(metric)}
      className={`px-3 py-2 text-sm ${value === metric ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
      {YEAR_METRIC_LABELS[metric]}
    </button>)}
  </div>
}

function YearControls({
  filters, years, devices, onChange,
}: {
  filters: YearFilters
  years: number[]
  devices: DeviceOption[]
  onChange: (value: YearFilters) => void
}) {
  const choices = years.length ? years : [filters.year]
  return <section className="mb-6 flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:items-end">
    <label className="min-w-0 flex-1 text-xs text-zinc-500">
      <span className="mb-1.5 block">设备</span>
      <DeviceSelector devices={devices} value={filters.device}
        onChange={device => onChange({ ...filters, device })} />
    </label>
    <label className="text-xs text-zinc-500 sm:w-32">
      <span className="mb-1.5 block">年份</span>
      <select className="field-input" value={filters.year}
        onChange={event => onChange({ ...filters, year: Number(event.target.value) })}>
        {choices.map(year => <option key={year} value={year}>{year}</option>)}
      </select>
    </label>
    <label className="text-xs text-zinc-500">
      <span className="mb-1.5 block">指标</span>
      <MetricTabs value={filters.metric}
        onChange={metric => onChange({ ...filters, metric })} />
    </label>
  </section>
}

function YearReport({ filters, stats }: { filters: YearFilters; stats: YearStatsResponse }) {
  const cards = yearSummaryCards(stats, filters.metric)
  return <div className="space-y-6">
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {cards.map(card => <div key={card.label}
        className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
        <p className="mb-1 text-xs text-zinc-500">{card.label}</p>
        <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
        {card.sub ? <p className="mt-1 text-[11px] text-zinc-600">{card.sub}</p> : null}
      </div>)}
    </div>
    <YearHeatmap year={filters.year} daily={stats.daily} metric={filters.metric} />
    <MonthlyBar data={stats.monthly} metric={filters.metric} />
  </div>
}

interface Props {
  onBack: () => void
  devices: ResourceState<DeviceOption[]>
  onRefreshDevices: () => void
}

export function YearPage({ onBack, devices, onRefreshDevices }: Props) {
  const filters = yearFiltersFromHash(window.location.hash)
  const { state, refresh } = useYearData(API, filters.year, filters.device)
  const stats = state.data
  const navigate = (next: YearFilters) => { window.location.hash = yearHash(next) }

  useEffect(() => {
    if (devices.data && filters.device !== 'all'
      && !devices.data.some(device => device.id === filters.device)) {
      navigate({ ...filters, device: 'all' })
    }
  }, [devices.data, filters.device])
  useEffect(() => {
    if (stats?.available_years.length && !stats.available_years.includes(filters.year)) {
      navigate({ ...filters, year: stats.available_years[0] })
    }
  }, [filters.year, stats?.available_years.join(',')])

  return <div className="min-h-screen">
    <YearHeader onBack={onBack} />
    <YearControls filters={filters} years={stats?.available_years ?? []}
      devices={devices.data ?? []} onChange={navigate} />
    {devices.status === 'error' || devices.status === 'stale' ? <ReadFeedback
      loading={false} hasData={devices.data != null} error={devices.error}
      label="加载设备中…" onRetry={onRefreshDevices} /> : null}
    <ResourceView status={state.status} error={state.error}
      empty={stats?.daily.length === 0} loadingLabel="加载年度数据…"
      emptyLabel={stats?.available_years.length
        ? `${filters.year} 年暂无用量记录` : '当前设备还没有年度用量记录'}
      onRetry={() => { refresh() }}>
      {stats ? <YearReport filters={filters} stats={stats} /> : null}
    </ResourceView>
  </div>
}
