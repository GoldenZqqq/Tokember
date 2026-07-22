import type { DashboardRange, SourceFilters } from '../../analytics/date-range'
import type { DeviceOption } from '../../dashboard-stats'
import type { ResourceState } from '../../data/resource-state'
import { useT } from '../../i18n'
import { DeviceSelector } from '../DeviceSelector'
import { ResourceView } from '../ResourceView'
import { useSourceData } from '../../hooks/use-source-data'
import { providerDisplayName } from '../../provider-display'
import { mergeByModelFamily, modelDisplayName } from '../../model-display'

const SOURCE_RANGES: Array<{ value: DashboardRange; labelKey: string }> = [
  { value: 'today', labelKey: 'range.today' },
  { value: 7, labelKey: 'range.d7' },
  { value: 30, labelKey: 'range.d30' },
  { value: 0, labelKey: 'range.all' },
]

interface Props {
  api: string
  filters: SourceFilters
  devices: ResourceState<DeviceOption[]>
  onFiltersChange: (filters: SourceFilters) => void
  onBack: () => void
}

function number(value: number, locale: string): string {
  return value.toLocaleString(locale)
}

function cost(value: number): string {
  return `$${value.toFixed(3)}`
}

function rangeFilters(filters: SourceFilters, range: DashboardRange): SourceFilters {
  return {
    provider: filters.provider,
    device: filters.device,
    project: filters.project,
    range,
    comparison: 'none',
  }
}

function useNumberLocale(): string {
  const { locale } = (() => {
    try {
      // prefer document lang when available
      if (typeof document !== 'undefined' && document.documentElement.lang.startsWith('zh')) {
        return { locale: 'zh-CN' as const }
      }
    } catch { /* ignore */ }
    return { locale: 'en-US' as const }
  })()
  return locale
}

function SourceHeader(props: Props & { refreshing: boolean; onRefresh: () => void }) {
  const t = useT()
  return <header className="mb-8 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" onClick={props.onBack} aria-label={t('source.backAria')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-orange-500">
          <span aria-hidden="true">←</span>
        </button>
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold text-zinc-100">
            {providerDisplayName(props.filters.provider)}
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">{t('source.ledger')}</p>
        </div>
      </div>
      <button type="button" onClick={props.onRefresh} disabled={props.refreshing}
        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-60">
        {props.refreshing ? t('source.refreshing') : t('source.refresh')}
      </button>
    </div>
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <DeviceSelector devices={props.devices.data ?? []} value={props.filters.device}
        onChange={device => props.onFiltersChange({ ...props.filters, device })} />
      <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-zinc-800"
        aria-label={t('source.rangeAria')}>
        {SOURCE_RANGES.map(option => <button key={String(option.value)} type="button"
          aria-pressed={props.filters.range === option.value}
          onClick={() => props.onFiltersChange(rangeFilters(props.filters, option.value))}
          className={`px-3 py-1.5 text-sm ${props.filters.range === option.value
            ? 'bg-zinc-800 text-zinc-100'
            : 'text-zinc-500 hover:text-zinc-300'}`}>
          {t(option.labelKey)}
        </button>)}
      </div>
    </div>
  </header>
}

function SourceOverview({ data }: { data: ReturnType<typeof useSourceData>['state']['data'] }) {
  const t = useT()
  const locale = useNumberLocale()
  if (!data) return null
  const latest = data.records[0]?.timestamp
  const cards = [
    [t('source.calls'), number(data.stats.total_requests, locale)],
    [t('source.tokens'), number(data.stats.real_total_tokens, locale)],
    [t('source.cost'), cost(data.stats.total_cost)],
    [t('source.latestCall'), latest ? new Date(latest).toLocaleString(locale) : t('source.noLatest')],
  ]
  return <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('source.summaryAria')}>
    {cards.map(([label, value]) => <div key={label}
      className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 break-words text-lg font-semibold tabular-nums text-zinc-100">{value}</p>
    </div>)}
  </section>
}

function ModelBreakdown({ data }: { data: ReturnType<typeof useSourceData>['state']['data'] }) {
  const t = useT()
  const locale = useNumberLocale()
  if (!data) return null
  const rows = mergeByModelFamily(data.stats.by_model)
  return <section className="overflow-hidden rounded-lg border border-zinc-800/60">
    <header className="border-b border-zinc-800/60 px-4 py-3">
      <h2 className="text-sm font-medium text-zinc-300">{t('source.modelDist')}</h2>
      <p className="mt-1 text-[11px] text-zinc-600">{t('source.modelDistHint')}</p>
    </header>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <thead className="text-zinc-500"><tr>
          <th className="px-4 py-2.5 text-left font-medium">{t('source.model')}</th>
          <th className="px-4 py-2.5 text-right font-medium">{t('source.calls')}</th>
          <th className="px-4 py-2.5 text-right font-medium">{t('source.tokens')}</th>
          <th className="px-4 py-2.5 text-right font-medium">{t('source.cost')}</th>
        </tr></thead>
        <tbody className="divide-y divide-zinc-800/40">
          {rows.map(row => <tr key={`${row.provider}:${row.model}`}>
            <td className="break-all px-4 py-3 text-xs text-zinc-300" title={row.raw_models.join(', ')}>
              {modelDisplayName(row.model)}
              {row.raw_models.length > 1 && (
                <span className="ml-2 font-mono text-[10px] text-zinc-600">
                  {t('source.tiers', { n: row.raw_models.length })}
                </span>
              )}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.requests, locale)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.real_total_tokens, locale)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-orange-300">{cost(row.cost)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>
}

function CallRecords(props: ReturnType<typeof useSourceData>) {
  const t = useT()
  const locale = useNumberLocale()
  const data = props.state.data
  if (!data) return null
  return <section className="overflow-hidden rounded-lg border border-zinc-800/60">
    <header className="border-b border-zinc-800/60 px-4 py-3">
      <h2 className="text-sm font-medium text-zinc-300">{t('source.callRecords')}</h2>
    </header>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] text-sm">
        <thead className="text-zinc-500"><tr>
          <th className="px-4 py-2.5 text-left font-medium">{t('source.time')}</th>
          <th className="px-4 py-2.5 text-left font-medium">{t('source.model')}</th>
          <th className="px-4 py-2.5 text-left font-medium">{t('source.deviceProject')}</th>
          <th className="px-4 py-2.5 text-right font-medium">{t('source.calls')}</th>
          <th className="px-4 py-2.5 text-right font-medium">{t('source.tokens')}</th>
          <th className="px-4 py-2.5 text-right font-medium">{t('source.cost')}</th>
        </tr></thead>
        <tbody className="divide-y divide-zinc-800/40">
          {data.records.map(row => <tr key={row.id}>
            <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400">
              {new Date(row.timestamp).toLocaleString(locale)}
            </td>
            <td className="max-w-72 break-all px-4 py-3 font-mono text-xs text-zinc-300">{row.model}</td>
            <td className="px-4 py-3 text-xs text-zinc-400">
              <span className="block">{row.device_name}</span>
              <span className="block text-zinc-600">{row.project_name ?? t('source.unattributedProject')}</span>
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.request_count, locale)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.real_total_tokens, locale)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-orange-300">
              {row.pricing_status === 'unpriced' ? t('source.unpriced') : cost(row.cost_usd)}
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {data.nextCursor || props.pageError ? <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/60 px-4 py-3">
      <p className="text-xs text-red-300">{props.pageError?.message ?? ''}</p>
      {data.nextCursor ? <button type="button" onClick={props.loadMore}
        disabled={props.loadingMore}
        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-60">
        {props.loadingMore ? t('common.loading') : t('source.loadMore')}
      </button> : null}
    </div> : null}
  </section>
}

export function SourcePage(props: Props) {
  const t = useT()
  const source = useSourceData({ api: props.api, ...props.filters })
  const data = source.state.data
  return <>
    <SourceHeader {...props}
      refreshing={source.state.status === 'refreshing'} onRefresh={source.refresh} />
    <ResourceView status={source.state.status} error={source.state.error}
      empty={data != null && data.stats.total_requests === 0}
      loadingLabel={t('source.loadingCalls')} emptyLabel={t('source.emptyCalls')}
      onRetry={source.refresh}>
      <div className="space-y-6">
        <SourceOverview data={data} />
        <ModelBreakdown data={data} />
        <CallRecords {...source} />
      </div>
    </ResourceView>
  </>
}
