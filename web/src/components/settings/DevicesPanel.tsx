import { useEffect, useState } from 'react'
import type {
  CollectorDeviceStatus,
  CollectorSourceHealth,
  CollectorSourceStatus,
} from '@tokember/contracts/collector-observability'
import { adminApi, type DeviceSummary } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { useT, type TranslateFn } from '../../i18n'
import { providerDisplayName } from '../../provider-display'
import { ReadFeedback } from '../ReadFeedback'
import { DeviceCredentialPanel } from './DeviceCredentialPanel'

const PLATFORM_LABELS = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', other: 'Other',
} as const

function healthMeta(status: CollectorDeviceStatus, t: TranslateFn): { label: string; className: string } {
  const styles: Record<CollectorDeviceStatus, string> = {
    healthy: 'bg-emerald-500/10 text-emerald-300',
    degraded: 'bg-amber-500/10 text-amber-300',
    offline: 'bg-white/[0.04] text-zinc-400',
    never: 'bg-white/[0.04] text-zinc-500',
  }
  const labels: Record<CollectorDeviceStatus, string> = {
    healthy: t('health.healthy'),
    degraded: t('health.degraded'),
    offline: t('health.offline'),
    never: t('health.never'),
  }
  return { label: labels[status], className: styles[status] }
}

function sourceMeta(status: CollectorSourceStatus, t: TranslateFn): { label: string; className: string } {
  const styles: Record<CollectorSourceStatus, string> = {
    success: 'text-emerald-300',
    collection_failed: 'text-rose-300',
    upload_failed: 'text-amber-300',
  }
  const labels: Record<CollectorSourceStatus, string> = {
    success: t('health.success'),
    collection_failed: t('health.collectionFailed'),
    upload_failed: t('health.uploadFailed'),
  }
  return { label: labels[status], className: styles[status] }
}

function machineDescription(device: DeviceSummary, t: TranslateFn): string {
  const values = [
    device.platform ? PLATFORM_LABELS[device.platform] : null,
    device.architecture,
    device.hostname,
  ].filter((value): value is string => Boolean(value))
  return values.join(' · ') || t('devicesUi.waitingMeta')
}

function parseTime(value: string | null): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const time = new Date(normalized).getTime()
  return Number.isFinite(time) ? time : null
}

function formatDuration(ms: number, t: TranslateFn): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t('relative.seconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('relative.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('relative.hours', { n: hours })
  return t('relative.days', { n: Math.round(hours / 24) })
}

function formatRelative(value: string | null, t: TranslateFn): string {
  const time = parseTime(value)
  if (time == null) return t('devicesUi.never')
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return t('relative.secondsAgo', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('relative.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('relative.hoursAgo', { n: hours })
  return t('relative.daysAgo', { n: Math.round(hours / 24) })
}

function formatSchedule(minutes: number | null, t: TranslateFn): string {
  if (minutes == null) return t('devicesUi.notReported')
  if (minutes % 60 === 0) return t('devicesUi.everyHours', { n: minutes / 60 })
  return t('devicesUi.everyMinutes', { n: minutes })
}

function formatOutcome(value: number | null, t: TranslateFn): string {
  return value == null ? t('common.unknown') : value.toLocaleString()
}

export function DevicesPanel() {
  const t = useT()
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
        label={t('devicesUi.loading')} onRetry={() => { load() }}
      />
      {devices.length > 0 || (!loading && !error) ? <DeviceSummaryBar devices={devices} /> : null}
      <DeviceCredentialPanel devices={devices} />
      <section className="space-y-3">
        {!loading && !error && devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
            {t('devicesUi.empty')}
          </div>
        ) : devices.map(device => <DeviceCard key={device.id} device={device} />)}
      </section>
    </div>
  )
}

function PanelHeader({ onRefresh }: { onRefresh: () => void }) {
  const t = useT()
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-zinc-100">{t('devicesUi.title')}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          {t('devicesUi.subtitle')}
        </p>
      </div>
      <button
        type="button" onClick={onRefresh}
        className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60"
      >
        {t('common.refresh')}
      </button>
    </header>
  )
}

function DeviceSummaryBar({ devices }: { devices: DeviceSummary[] }) {
  const t = useT()
  const count = (status: CollectorDeviceStatus) =>
    devices.filter(device => device.collector.status === status).length
  return (
    <dl className="flex flex-wrap divide-x divide-white/[0.06] rounded-xl border border-white/[0.06] bg-zinc-900/45 px-2 py-3">
      <SummaryMetric label={t('devicesUi.devices')} value={devices.length} />
      <SummaryMetric label={t('devicesUi.healthy')} value={count('healthy')} tone="text-emerald-300" />
      <SummaryMetric label={t('devicesUi.degraded')} value={count('degraded')} tone="text-amber-300" />
      <SummaryMetric label={t('devicesUi.offlinePending')} value={count('offline') + count('never')} />
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
  const t = useT()
  const collector = device.collector
  const health = healthMeta(collector.status, t)
  return (
    <article className="rounded-xl border border-white/[0.07] bg-zinc-900/45 p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-100">{device.name}</h3>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">{machineDescription(device, t)}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{device.id}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${health.className}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
          {health.label}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric label={t('devicesUi.lastSuccess')} value={formatRelative(collector.last_successful_at, t)} />
        <Metric label={t('devicesUi.schedule')} value={formatSchedule(collector.latest_run?.schedule_interval_minutes ?? null, t)} />
        <Metric label={t('devicesUi.runDuration')} value={collector.latest_run ? formatDuration(collector.latest_run.duration_ms, t) : '—'} />
        <Metric label={t('devicesUi.latestUsage')} value={formatRelative(device.last_record_at, t)} />
      </dl>
      <p className="mt-3 text-xs text-zinc-500">
        {t('devicesUi.lastRegistered', { time: formatRelative(device.last_seen_at, t) })}
        {collector.freshness_threshold_minutes != null
          ? t('devicesUi.offlineAfter', { minutes: collector.freshness_threshold_minutes })
          : collector.latest_run
            ? t('devicesUi.perToolHealth')
            : t('devicesUi.waitingFirstRun')}
      </p>
      <SourceDetails sources={collector.sources} />
    </article>
  )
}

function SourceDetails({ sources }: { sources: CollectorSourceHealth[] }) {
  const t = useT()
  if (sources.length === 0) {
    return <p className="mt-4 border-t border-white/[0.06] pt-3 text-xs text-zinc-500">{t('devicesUi.noSourceData')}</p>
  }
  return (
    <details className="group mt-4 border-t border-white/[0.06] pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-md py-1 text-sm font-medium text-zinc-300 outline-none transition hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-orange-500/60">
        <span>{t('devicesUi.toolSources', { n: sources.length })}</span>
        <span className="text-xs text-zinc-500 group-open:hidden">{t('devicesUi.expand')}</span>
        <span className="hidden text-xs text-zinc-500 group-open:inline">{t('devicesUi.collapse')}</span>
      </summary>
      <div className="mt-2 divide-y divide-white/[0.06]">
        {sources.map(source => <SourceRow key={source.source} source={source} />)}
      </div>
    </details>
  )
}

function SourceRow({ source }: { source: CollectorSourceHealth }) {
  const t = useT()
  const status = sourceMeta(source.status, t)
  return (
    <section className="py-3 first:pt-2 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold text-zinc-200">
            {providerDisplayName(source.source)}
          </h4>
          <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
        </div>
        <span className="text-xs text-zinc-500">{formatRelative(source.finished_at, t)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4 lg:grid-cols-8">
        <Metric label={t('devicesUi.discoveredScanned')} value={`${source.discovered} / ${source.scanned}`} compact />
        <Metric label={t('devicesUi.emitted')} value={source.emitted.toLocaleString()} compact />
        <Metric label={t('devicesUi.accepted')} value={formatOutcome(source.accepted, t)} compact />
        <Metric label={t('devicesUi.unchanged')} value={formatOutcome(source.unchanged, t)} compact />
        <Metric label={t('devicesUi.watermark')} value={formatRelative(source.watermark_at, t)} compact />
        <Metric label={t('devicesUi.latestUsage')} value={formatRelative(source.last_usage_at, t)} compact />
        <Metric label={t('devicesUi.duration')} value={formatDuration(source.duration_ms, t)} compact />
        <Metric label={t('devicesUi.consecutiveFailures')} value={String(source.consecutive_failures)} compact />
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
