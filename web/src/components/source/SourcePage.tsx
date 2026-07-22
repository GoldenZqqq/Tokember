import type { DashboardRange, SourceFilters } from '../../analytics/date-range'
import type { DeviceOption } from '../../dashboard-stats'
import type { ResourceState } from '../../data/resource-state'
import { DeviceSelector } from '../DeviceSelector'
import { ResourceView } from '../ResourceView'
import { useSourceData } from '../../hooks/use-source-data'
import { providerDisplayName } from '../../provider-display'
import { mergeByModelFamily, modelDisplayName } from '../../model-display'

const SOURCE_RANGES: Array<{ value: DashboardRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 0, label: 'All' },
]

interface Props {
  api: string
  filters: SourceFilters
  devices: ResourceState<DeviceOption[]>
  onFiltersChange: (filters: SourceFilters) => void
  onBack: () => void
}

function number(value: number): string {
  return value.toLocaleString('zh-CN')
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

function SourceHeader(props: Props & { refreshing: boolean; onRefresh: () => void }) {
  return <header className="mb-8 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" onClick={props.onBack} aria-label="返回首页"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-orange-500">
          <span aria-hidden="true">←</span>
        </button>
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold text-zinc-100">
            {providerDisplayName(props.filters.provider)}
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">工具调用账本</p>
        </div>
      </div>
      <button type="button" onClick={props.onRefresh} disabled={props.refreshing}
        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-60">
        {props.refreshing ? '刷新中…' : '刷新'}
      </button>
    </div>
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <DeviceSelector devices={props.devices.data ?? []} value={props.filters.device}
        onChange={device => props.onFiltersChange({ ...props.filters, device })} />
      <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-zinc-800"
        aria-label="工具统计时间范围">
        {SOURCE_RANGES.map(option => <button key={option.value} type="button"
          aria-pressed={props.filters.range === option.value}
          onClick={() => props.onFiltersChange(rangeFilters(props.filters, option.value))}
          className={`px-3 py-1.5 text-sm ${props.filters.range === option.value
            ? 'bg-zinc-800 text-zinc-100'
            : 'text-zinc-500 hover:text-zinc-300'}`}>
          {option.label}
        </button>)}
      </div>
    </div>
  </header>
}

function SourceOverview({ data }: { data: ReturnType<typeof useSourceData>['state']['data'] }) {
  if (!data) return null
  const latest = data.records[0]?.timestamp
  const cards = [
    ['Calls', number(data.stats.total_requests)],
    ['Real Tokens', number(data.stats.real_total_tokens)],
    ['Cost', cost(data.stats.total_cost)],
    ['最近调用', latest ? new Date(latest).toLocaleString('zh-CN') : '暂无'],
  ]
  return <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="工具用量摘要">
    {cards.map(([label, value]) => <div key={label}
      className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 break-words text-lg font-semibold tabular-nums text-zinc-100">{value}</p>
    </div>)}
  </section>
}

function ModelBreakdown({ data }: { data: ReturnType<typeof useSourceData>['state']['data'] }) {
  if (!data) return null
  const rows = mergeByModelFamily(data.stats.by_model)
  return <section className="overflow-hidden rounded-lg border border-zinc-800/60">
    <header className="border-b border-zinc-800/60 px-4 py-3">
      <h2 className="text-sm font-medium text-zinc-300">模型分布</h2>
      <p className="mt-1 text-[11px] text-zinc-600">按模型族归并；免费/Build 计费档已合并</p>
    </header>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <thead className="text-zinc-500"><tr>
          <th className="px-4 py-2.5 text-left font-medium">模型</th>
          <th className="px-4 py-2.5 text-right font-medium">Calls</th>
          <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
          <th className="px-4 py-2.5 text-right font-medium">Cost</th>
        </tr></thead>
        <tbody className="divide-y divide-zinc-800/40">
          {rows.map(row => <tr key={`${row.provider}:${row.model}`}>
            <td className="break-all px-4 py-3 text-xs text-zinc-300" title={row.raw_models.join(', ')}>
              {modelDisplayName(row.model)}
              {row.raw_models.length > 1 && (
                <span className="ml-2 font-mono text-[10px] text-zinc-600">
                  {row.raw_models.length} 档
                </span>
              )}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.requests)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.real_total_tokens)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-orange-300">{cost(row.cost)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>
}

function CallRecords(props: ReturnType<typeof useSourceData>) {
  const data = props.state.data
  if (!data) return null
  return <section className="overflow-hidden rounded-lg border border-zinc-800/60">
    <header className="border-b border-zinc-800/60 px-4 py-3">
      <h2 className="text-sm font-medium text-zinc-300">逻辑调用记录</h2>
    </header>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] text-sm">
        <thead className="text-zinc-500"><tr>
          <th className="px-4 py-2.5 text-left font-medium">时间</th>
          <th className="px-4 py-2.5 text-left font-medium">模型</th>
          <th className="px-4 py-2.5 text-left font-medium">设备 / 项目</th>
          <th className="px-4 py-2.5 text-right font-medium">Calls</th>
          <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
          <th className="px-4 py-2.5 text-right font-medium">Cost</th>
        </tr></thead>
        <tbody className="divide-y divide-zinc-800/40">
          {data.records.map(row => <tr key={row.id}>
            <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400">
              {new Date(row.timestamp).toLocaleString('zh-CN')}
            </td>
            <td className="max-w-72 break-all px-4 py-3 font-mono text-xs text-zinc-300">{row.model}</td>
            <td className="px-4 py-3 text-xs text-zinc-400">
              <span className="block">{row.device_name}</span>
              <span className="block text-zinc-600">{row.project_name ?? '未归因项目'}</span>
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.request_count)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{number(row.real_total_tokens)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-orange-300">
              {row.pricing_status === 'unpriced' ? '未计价' : cost(row.cost_usd)}
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
        {props.loadingMore ? '加载中…' : '加载更多'}
      </button> : null}
    </div> : null}
  </section>
}

export function SourcePage(props: Props) {
  const source = useSourceData({ api: props.api, ...props.filters })
  const data = source.state.data
  return <>
    <SourceHeader {...props}
      refreshing={source.state.status === 'refreshing'} onRefresh={source.refresh} />
    <ResourceView status={source.state.status} error={source.state.error}
      empty={data != null && data.stats.total_requests === 0}
      loadingLabel="加载工具调用…" emptyLabel="当前范围没有该工具的调用记录"
      onRetry={source.refresh}>
      <div className="space-y-6">
        <SourceOverview data={data} />
        <ModelBreakdown data={data} />
        <CallRecords {...source} />
      </div>
    </ResourceView>
  </>
}
