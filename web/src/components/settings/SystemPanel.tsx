import { useEffect, useState } from 'react'
import { adminApi, type SystemInfo } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import {
  readBurnPreference,
  writeBurnPreference,
  type BurnPreference,
} from '../../burn/burn-preference'
import { useT, type TranslateFn } from '../../i18n'
import { ReadFeedback } from '../ReadFeedback'

function formatRelative(value: string | null, t: TranslateFn): string {
  if (!value) return t('relative.never')
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  const time = new Date(normalized).getTime()
  if (!Number.isFinite(time)) return t('common.unknown')
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return t('relative.secondsAgo', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('relative.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('relative.hoursAgo', { n: hours })
  return t('relative.daysAgo', { n: Math.round(hours / 24) })
}

function formatUptime(startedAt: string, t: TranslateFn): string {
  const started = new Date(startedAt).getTime()
  if (!Number.isFinite(started)) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000))
  if (seconds < 60) return t('relative.seconds', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('relative.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 48) return t('systemUi.uptimeHoursMin', { hours, min: remMin })
  return t('systemUi.uptimeDaysHours', { days: Math.floor(hours / 24), hours: hours % 24 })
}

function shortHash(value: string): string {
  return /^[a-f0-9]{12,}$/i.test(value) ? value.slice(0, 12) : value
}

const HEALTH_STYLES = {
  ok: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  degraded: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  error: 'bg-red-500/10 text-red-300 border-red-500/20',
} as const

function healthLabel(status: keyof typeof HEALTH_STYLES, t: TranslateFn): string {
  if (status === 'ok') return t('systemUi.healthOk')
  if (status === 'degraded') return t('systemUi.healthDegraded')
  return t('systemUi.healthError')
}

function collectorLabel(status: SystemInfo['devices'][number]['collector_status'], t: TranslateFn): string {
  if (status === 'healthy') return t('health.healthy')
  if (status === 'degraded') return t('health.degraded')
  if (status === 'offline') return t('health.offline')
  return t('health.never')
}

const RECOVERY_STYLES = {
  never: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  healthy: HEALTH_STYLES.ok,
  stale: HEALTH_STYLES.degraded,
  backup_failed: HEALTH_STYLES.error,
  drill_failed: HEALTH_STYLES.error,
} as const

function recoveryLabel(state: keyof typeof RECOVERY_STYLES, t: TranslateFn): string {
  if (state === 'never') return t('systemUi.recoveryNever')
  if (state === 'healthy') return t('systemUi.recoveryHealthy')
  if (state === 'stale') return t('systemUi.recoveryStale')
  if (state === 'backup_failed') return t('systemUi.recoveryBackupFailed')
  return t('systemUi.recoveryDrillFailed')
}

function checkLabel(state: 'never' | 'passed' | 'failed', t: TranslateFn): string {
  if (state === 'never') return t('systemUi.checkNever')
  if (state === 'passed') return t('systemUi.checkPassed')
  return t('systemUi.checkFailed')
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 break-all text-xl font-semibold tabular-nums text-zinc-100">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  )
}

function PanelHeader({ info, refresh }: { info: SystemInfo; refresh: () => void }) {
  const t = useT()
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-400">System</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">{t('systemUi.title')}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          {t('systemUi.subtitle')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${HEALTH_STYLES[info.health.status]}`}>
          {healthLabel(info.health.status, t)}
        </span>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07]"
        >
          {t('common.refresh')}
        </button>
      </div>
    </header>
  )
}

function RuntimeCards({ info }: { info: SystemInfo }) {
  const t = useT()
  const build = info.build
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('systemUi.release')} value={build?.release_id ?? `v${info.version}`} hint={`v${info.version} · ${info.node_env}`} />
        <StatCard label={t('systemUi.uptime')} value={formatUptime(info.started_at, t)} hint={new Date(info.started_at).toLocaleString()} />
        <StatCard label={t('systemUi.database')} value={info.db_path} hint={info.db_ok ? t('systemUi.dbOk') : t('systemUi.dbFail')} />
        <StatCard label={t('systemUi.devicesOnline')} value={`${info.health.online_devices}/${info.counts.devices}`} hint={t('systemUi.devicesOnlineHint')} />
      </section>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Commit" value={shortHash(build?.commit ?? 'unknown')} />
        <StatCard label="Lockfile" value={shortHash(build?.lockfile_sha256 ?? 'unknown')} />
        <StatCard
          label={t('systemUi.builtAt')}
          value={build ? new Date(build.built_at).toLocaleString() : '—'}
          hint={build
            ? `Build Node ${build.node_version} (${build.architecture ?? 'unknown'}) · Runtime Node ${info.runtime_node_version ?? 'unknown'} (${info.runtime_architecture ?? 'unknown'})`
            : t('systemUi.oldServer')}
        />
      </section>
    </>
  )
}

function PricingStatusSection({ rows }: { rows: SystemInfo['pricing_status'] }) {
  const t = useT()
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-zinc-200">{t('systemUi.pricingDist')}</h3>
      {!rows.length ? <p className="mt-3 text-sm text-zinc-600">{t('systemUi.noUsage')}</p> : (
        <div className="mt-3 flex flex-wrap gap-2">
          {rows.map(row => (
            <span key={row.status} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-zinc-300">
              <span className="font-mono text-xs text-zinc-500">{row.status}</span>
              <span className="tabular-nums text-zinc-100">{row.count.toLocaleString()}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function DeviceCollectorSection({ devices }: { devices: SystemInfo['devices'] }) {
  const t = useT()
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-zinc-200">{t('systemUi.deviceCollection')}</h3>
      {!devices.length ? <p className="mt-3 text-sm text-zinc-600">{t('systemUi.noDevices')}</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-600">
              <tr>
                {[t('systemUi.colDevice'), t('systemUi.colStatus'), t('systemUi.colLastSuccess'), t('systemUi.colRecords')].map(label => (
                  <th key={label} className="pb-2 pr-4 font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {devices.map(device => (
                <tr key={device.id} className="text-zinc-300">
                  <td className="py-2 pr-4">
                    <div className="font-medium text-zinc-100">{device.name}</div>
                    <div className="font-mono text-[11px] text-zinc-600">{device.id}</div>
                  </td>
                  <td className={`py-2 pr-4 ${device.collector_status === 'healthy' ? 'text-emerald-300' : 'text-zinc-500'}`}>
                    {collectorLabel(device.collector_status, t)}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{formatRelative(device.last_successful_run_at, t)}</td>
                  <td className="py-2 tabular-nums">{device.record_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function formatBytes(value: number | null): string {
  if (value == null) return '—'
  if (value < 1024 * 1024) return `${Math.round(value / 1024).toLocaleString()} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatAge(seconds: number | null, t: TranslateFn): string {
  if (seconds == null) return '—'
  if (seconds < 60) return t('relative.secondsAgo', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('relative.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('relative.hoursAgo', { n: hours })
  return t('relative.daysAgo', { n: Math.round(hours / 24) })
}

export function RecoverySection({ recovery }: { recovery: SystemInfo['recovery'] }) {
  const t = useT()
  return (
    <section className="border-t border-white/[0.06] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">{t('systemUi.recovery')}</h3>
          <p className="mt-1 text-xs text-zinc-600">{t('systemUi.recoveryHint')}</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${RECOVERY_STYLES[recovery.state]}`}>
          {recoveryLabel(recovery.state, t)}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('systemUi.backupAge')} value={formatAge(recovery.age_seconds, t)} />
        <StatCard label={t('systemUi.replicaSize')} value={formatBytes(recovery.backup_bytes)} />
        <StatCard label="Schema" value={recovery.schema_version == null ? '—' : String(recovery.schema_version)} />
        <StatCard label={t('systemUi.integrity')} value={checkLabel(recovery.integrity, t)} />
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        {t('systemUi.lastDrill', { state: checkLabel(recovery.drill.state, t) })}
        {recovery.drill.duration_ms == null ? '' : ` · ${recovery.drill.duration_ms.toLocaleString()} ms`}
        {recovery.last_failure_at ? t('systemUi.lastFailure', { time: formatRelative(recovery.last_failure_at, t) }) : ''}
      </p>
    </section>
  )
}

function useSystemInfo() {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  async function load() {
    setLoading(true)
    setError(null)
    try {
      setInfo(await adminApi.systemInfo())
    } catch (reason) {
      setError(toApiError(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load().catch(() => {}) }, [])
  return { info, loading, error, load }
}

function BurnFxSection() {
  const t = useT()
  const [preference, setPreference] = useState<BurnPreference>(() => readBurnPreference())
  const options: { value: BurnPreference; label: string; hint: string }[] = [
    { value: 'auto', label: t('systemUi.burnAuto'), hint: t('systemUi.burnAutoHint') },
    { value: 'on', label: t('systemUi.burnOn'), hint: t('systemUi.burnOnHint') },
    { value: 'off', label: t('systemUi.burnOff'), hint: t('systemUi.burnOffHint') },
  ]
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-zinc-200">{t('systemUi.burnTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-600">
        {t('systemUi.burnBody')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map(option => {
          const active = preference === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                writeBurnPreference(option.value)
                setPreference(option.value)
              }}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                active
                  ? 'border-orange-500/40 bg-orange-500/10 text-orange-200'
                  : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200'
              }`}
              aria-pressed={active}
            >
              <span className="block font-medium">{option.label}</span>
              <span className="mt-0.5 block text-[11px] opacity-80">{option.hint}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function SystemPanel() {
  const t = useT()
  const { info, loading, error, load } = useSystemInfo()
  if (loading && !info) return <ReadFeedback loading hasData={false} error={null} label={t('systemUi.loading')} onRetry={() => { load() }} />
  if (!info) {
    return <ReadFeedback loading={false} hasData={false} error={error} label={t('systemUi.loading')} onRetry={() => { load() }} />
  }
  return <div className="space-y-5">
    <ReadFeedback loading={loading} hasData error={error} label={t('systemUi.loading')} onRetry={() => { load() }} />
    <PanelHeader info={info} refresh={() => { load().catch(() => {}) }} />
    <RuntimeCards info={info} />
    <BurnFxSection />
    <RecoverySection recovery={info.recovery} />
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard label={t('systemUi.deviceCount')} value={String(info.counts.devices)} />
      <StatCard label={t('systemUi.usageRecords')} value={info.counts.usage_records.toLocaleString()} />
      <StatCard label={t('systemUi.pricingRules')} value={String(info.counts.pricing_rules)} />
    </section>
    {info.health.notes.length > 0 ? <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/90">
      <p className="font-medium">{t('systemUi.healthNotes')}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-100/80">{info.health.notes.map(note => <li key={note}>{note}</li>)}</ul>
    </section> : null}
    <PricingStatusSection rows={info.pricing_status} />
    <DeviceCollectorSection devices={info.devices} />
  </div>
}
