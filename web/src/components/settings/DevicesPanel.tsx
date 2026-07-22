import { useEffect, useState } from 'react'
import type {
  CollectorDeviceStatus,
  CollectorSourceHealth,
  CollectorSourceStatus,
} from '@tokember/contracts/collector-observability'
import { adminApi, type DeviceSummary } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { providerDisplayName } from '../../provider-display'
import { ReadFeedback } from '../ReadFeedback'
import { DeviceCredentialPanel } from './DeviceCredentialPanel'

const HEALTH_META: Record<CollectorDeviceStatus, { label: string; className: string }> = {
  healthy: { label: '健康', className: 'bg-emerald-500/10 text-emerald-300' },
  degraded: { label: '异常', className: 'bg-amber-500/10 text-amber-300' },
  offline: { label: '离线', className: 'bg-white/[0.04] text-zinc-400' },
  never: { label: '待上报', className: 'bg-white/[0.04] text-zinc-500' },
}

const SOURCE_META: Record<CollectorSourceStatus, { label: string; className: string }> = {
  success: { label: '成功', className: 'text-emerald-300' },
  collection_failed: { label: '采集失败', className: 'text-rose-300' },
  upload_failed: { label: '上传失败', className: 'text-amber-300' },
}

const PLATFORM_LABELS = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', other: 'Other',
} as const

function machineDescription(device: DeviceSummary): string {
  const values = [
    device.platform ? PLATFORM_LABELS[device.platform] : null,
    device.architecture,
    device.hostname,
  ].filter((value): value is string => Boolean(value))
  return values.join(' · ') || '等待机器元数据上报'
}

function parseTime(value: string | null): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const time = new Date(normalized).getTime()
  return Number.isFinite(time) ? time : null
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

function formatRelative(value: string | null): string {
  const time = parseTime(value)
  return time == null ? '从未' : `${formatDuration(Date.now() - time)}前`
}

function formatSchedule(minutes: number | null): string {
  if (minutes == null) return '未上报'
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

function formatOutcome(value: number | null): string {
  return value == null ? '未知' : value.toLocaleString('zh-CN')
}

export function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setDevices((await adminApi.devices()).devices)
    } catch (reason) {
      setError(toApiError(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-5">
      <PanelHeader onRefresh={() => { load() }} />
      <ReadFeedback
        loading={loading} hasData={devices.length > 0} error={error}
        label="加载设备中…" onRetry={() => { load() }}
      />
      {devices.length > 0 || (!loading && !error) ? <DeviceSummaryBar devices={devices} /> : null}
      <DeviceCredentialPanel devices={devices} />
      <section className="space-y-3">
        {!loading && !error && devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
            尚无完整采集运行。Collector 注册并完成一次运行后，这里会显示来源状态。
          </div>
        ) : devices.map(device => <DeviceCard key={device.id} device={device} />)}
      </section>
    </div>
  )
}

function PanelHeader({ onRefresh }: { onRefresh: () => void }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-zinc-100">设备与采集器</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          健康状态以完成的采集运行计算；注册心跳、来源扫描和用量上传分别记录。
        </p>
      </div>
      <button
        type="button" onClick={onRefresh}
        className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60"
      >
        刷新
      </button>
    </header>
  )
}

function DeviceSummaryBar({ devices }: { devices: DeviceSummary[] }) {
  const count = (status: CollectorDeviceStatus) =>
    devices.filter(device => device.collector.status === status).length
  return (
    <dl className="flex flex-wrap divide-x divide-white/[0.06] rounded-xl border border-white/[0.06] bg-zinc-900/45 px-2 py-3">
      <SummaryMetric label="设备" value={devices.length} />
      <SummaryMetric label="健康" value={count('healthy')} tone="text-emerald-300" />
      <SummaryMetric label="异常" value={count('degraded')} tone="text-amber-300" />
      <SummaryMetric label="离线 / 待上报" value={count('offline') + count('never')} />
    </dl>
  )
}

function SummaryMetric({ label, value, tone = 'text-zinc-200' }: {
  label: string; value: number; tone?: string
}) {
  return (
    <div className="min-w-[7rem] flex-1 px-3 py-1">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  )
}

export function DeviceCard({ device }: { device: DeviceSummary }) {
  const collector = device.collector
  const health = HEALTH_META[collector.status]
  return (
    <article className="rounded-xl border border-white/[0.07] bg-zinc-900/45 p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-100">{device.name}</h3>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">{machineDescription(device)}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{device.id}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${health.className}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
          {health.label}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric label="最近成功" value={formatRelative(collector.last_successful_at)} />
        <Metric label="采集周期" value={formatSchedule(collector.latest_run?.schedule_interval_minutes ?? null)} />
        <Metric label="本轮耗时" value={collector.latest_run ? formatDuration(collector.latest_run.duration_ms) : '—'} />
        <Metric label="最新用量" value={formatRelative(device.last_record_at)} />
      </dl>
      <p className="mt-3 text-xs text-zinc-500">
        最近注册 {formatRelative(device.last_seen_at)}
        {collector.freshness_threshold_minutes != null
          ? ` · ${collector.freshness_threshold_minutes} 分钟无完整运行后判定离线`
          : collector.latest_run
            ? ' · 各工具按自身采集周期判断健康状态'
            : ' · 等待首个完整运行'}
      </p>
      <SourceDetails sources={collector.sources} />
    </article>
  )
}

function SourceDetails({ sources }: { sources: CollectorSourceHealth[] }) {
  if (sources.length === 0) {
    return <p className="mt-4 border-t border-white/[0.06] pt-3 text-xs text-zinc-500">暂无来源级运行数据</p>
  }
  return (
    <details className="group mt-4 border-t border-white/[0.06] pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-md py-1 text-sm font-medium text-zinc-300 outline-none transition hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-orange-500/60">
        <span>工具来源 · {sources.length}</span>
        <span className="text-xs text-zinc-500 group-open:hidden">展开</span>
        <span className="hidden text-xs text-zinc-500 group-open:inline">收起</span>
      </summary>
      <div className="mt-2 divide-y divide-white/[0.06]">
        {sources.map(source => <SourceRow key={source.source} source={source} />)}
      </div>
    </details>
  )
}

function SourceRow({ source }: { source: CollectorSourceHealth }) {
  const status = SOURCE_META[source.status]
  return (
    <section className="py-3 first:pt-2 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold text-zinc-200">
            {providerDisplayName(source.source)}
          </h4>
          <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
        </div>
        <span className="text-xs text-zinc-500">{formatRelative(source.finished_at)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4 lg:grid-cols-8">
        <Metric label="发现 / 扫描" value={`${source.discovered} / ${source.scanned}`} compact />
        <Metric label="输出" value={source.emitted.toLocaleString('zh-CN')} compact />
        <Metric label="写入" value={formatOutcome(source.accepted)} compact />
        <Metric label="无变化" value={formatOutcome(source.unchanged)} compact />
        <Metric label="水位" value={formatRelative(source.watermark_at)} compact />
        <Metric label="最近用量" value={formatRelative(source.last_usage_at)} compact />
        <Metric label="耗时" value={formatDuration(source.duration_ms)} compact />
        <Metric label="连续失败" value={String(source.consecutive_failures)} compact />
      </dl>
      {source.error_summary ? (
        <p className="mt-2 break-words rounded-md bg-amber-500/[0.07] px-2.5 py-2 text-xs leading-5 text-amber-200/85">
          {source.error_summary}
        </p>
      ) : null}
    </section>
  )
}

function Metric({ label, value, compact = false }: {
  label: string; value: string; compact?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-zinc-500">{label}</dt>
      <dd className={`${compact ? 'text-xs' : 'text-sm'} mt-1 truncate font-medium tabular-nums text-zinc-200`} title={value}>
        {value}
      </dd>
    </div>
  )
}
