import { useEffect } from 'react'
import type { YearStatsResponse } from '@tokember/contracts/stats'
import type { DeviceOption } from '../../dashboard-stats'
import type { ResourceState } from '../../data/resource-state'
import { hasIncompleteCost } from '../../cost-coverage'
import {
  yearFiltersFromHash, yearHash, type YearFilters, type YearMetric,
} from '../../analytics/date-range'
import {
  annualMetricValue, formatAnnualMetric, yearMetricLabelKey,
} from '../../analytics/year-metric'
import { useT, type TranslateFn } from '../../i18n'
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

function yearSummaryCards(stats: YearStatsResponse, metric: YearMetric, t: TranslateFn) {
  const peak = peakFor(stats, metric)
  const incomplete = hasIncompleteCost(stats.totals.pricing_coverage)
  const metricLabel = t(yearMetricLabelKey(metric))
  const numberLocale = typeof document !== 'undefined' && document.documentElement.lang.startsWith('zh')
    ? 'zh-CN' : 'en-US'
  const secondary = metric === 'cost'
    ? { label: t('year.realTokens'), value: stats.totals.real_total_tokens.toLocaleString(numberLocale) }
    : {
      label: incomplete ? t('year.yearKnownCost') : t('year.yearCost'),
      value: `$${stats.totals.total_cost.toFixed(2)}`,
    }
  return [
    {
      label: metric === 'cost' && incomplete
        ? t('year.yearKnownCost')
        : t('year.yearMetric', { metric: metricLabel }),
      value: formatAnnualMetric(selectedTotal(stats, metric), metric), color: 'text-orange-400',
    },
    {
      label: t('year.activeDaysLabel'),
      value: t('year.activeDays', { n: stats.totals.active_days }),
      color: 'text-blue-400',
    },
    {
      label: t('year.peakDay', { metric: metricLabel }),
      value: peak.date ? formatAnnualMetric(peak.value, metric) : '—',
      sub: peak.date || undefined, color: 'text-emerald-400',
    },
    { ...secondary, color: 'text-purple-400' },
  ]
}

function YearHeader({ onBack }: { onBack: () => void }) {
  const t = useT()
  return <header className="mb-5 flex items-center justify-between border-b border-white/[0.06] pb-5">
    <button onClick={onBack} className="flex items-center gap-3 text-left">
      <img src="/icon-192.png" alt="" className="h-10 w-10 rounded-xl" />
      <span><span className="block whitespace-nowrap text-base font-bold text-zinc-100 sm:text-lg">{t('year.title')}</span>
        <span className="block text-xs text-zinc-600">Annual Report</span></span>
    </button>
    <button onClick={onBack}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
      aria-label={t('year.backAria')}>
      <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
    </button>
  </header>
}

function MetricTabs({ value, onChange }: { value: YearMetric; onChange: (value: YearMetric) => void }) {
  const t = useT()
  return <div className="flex overflow-hidden rounded-lg border border-zinc-800" aria-label={t('year.metricAria')}>
    {(['cost', 'tokens', 'calls'] as const).map(metric => <button type="button" key={metric}
      aria-pressed={value === metric} onClick={() => onChange(metric)}
      className={`px-3 py-2 text-sm ${value === metric ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
      {t(yearMetricLabelKey(metric))}
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
  const t = useT()
  const choices = years.length ? years : [filters.year]
  return <section className="mb-6 flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:items-end">
    <label className="min-w-0 flex-1 text-xs text-zinc-500">
      <span className="mb-1.5 block">{t('year.device')}</span>
      <DeviceSelector devices={devices} value={filters.device}
        onChange={device => onChange({ ...filters, device })} />
    </label>
    <label className="text-xs text-zinc-500 sm:w-32">
      <span className="mb-1.5 block">{t('year.yearLabel')}</span>
      <select className="field-input" value={filters.year}
        onChange={event => onChange({ ...filters, year: Number(event.target.value) })}>
        {choices.map(year => <option key={year} value={year}>{year}</option>)}
      </select>
    </label>
    <label className="text-xs text-zinc-500">
      <span className="mb-1.5 block">{t('year.metricLabel')}</span>
      <MetricTabs value={filters.metric}
        onChange={metric => onChange({ ...filters, metric })} />
    </label>
  </section>
}

function YearReport({ filters, stats }: { filters: YearFilters; stats: YearStatsResponse }) {
  const t = useT()
  const cards = yearSummaryCards(stats, filters.metric, t)
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
  const t = useT()
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
      label={t('common.loadingDevices')} onRetry={onRefreshDevices} /> : null}
    <ResourceView status={state.status} error={state.error}
      empty={stats?.daily.length === 0} loadingLabel={t('year.loadingYear')}
      emptyLabel={stats?.available_years.length
        ? t('year.emptyYear', { year: filters.year }) : t('year.noYearUsage')}
      onRetry={() => { refresh() }}>
      {stats ? <YearReport filters={filters} stats={stats} /> : null}
    </ResourceView>
  </div>
}
