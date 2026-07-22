import { useEffect, useState } from 'react'
import { adminApi, type SystemInfo } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import {
  readBurnPreference,
  writeBurnPreference,
  type BurnPreference,
} from '../../burn/burn-preference'
import { ReadFeedback } from '../ReadFeedback'

function formatRelative(value: string | null): string {
  if (!value) return '从未上报'
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  const time = new Date(normalized).getTime()
  if (!Number.isFinite(time)) return '未知'
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function formatUptime(startedAt: string): string {
  const started = new Date(startedAt).getTime()
  if (!Number.isFinite(started)) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 48) return `${hours} 小时 ${remMin} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

function shortHash(value: string): string {
  return /^[a-f0-9]{12,}$/i.test(value) ? value.slice(0, 12) : value
}

const HEALTH_STYLES = {
  ok: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  degraded: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  error: 'bg-red-500/10 text-red-300 border-red-500/20',
} as const

const HEALTH_LABELS = { ok: '健康', degraded: '降级', error: '异常' } as const
const COLLECTOR_LABELS = {
  healthy: '健康', degraded: '异常', offline: '离线', never: '待上报',
} as const

const RECOVERY_LABELS = {
  never: '未建立', healthy: '正常', stale: '已陈旧',
  backup_failed: '备份失败', drill_failed: '演练失败',
} as const
const RECOVERY_STYLES = {
  never: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  healthy: HEALTH_STYLES.ok,
  stale: HEALTH_STYLES.degraded,
  backup_failed: HEALTH_STYLES.error,
  drill_failed: HEALTH_STYLES.error,
} as const
const CHECK_LABELS = { never: '未执行', passed: '已通过', failed: '失败' } as const

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
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-400">System</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">系统信息</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          只读运行摘要：实际发布版本、数据库规模、计价状态分布与设备采集健康度。
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${HEALTH_STYLES[info.health.status]}`}>
          {HEALTH_LABELS[info.health.status]}
        </span>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07]"
        >
          刷新
        </button>
      </div>
    </header>
  )
}

function RuntimeCards({ info }: { info: SystemInfo }) {
  const build = info.build
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="发布版本" value={build?.release_id ?? `v${info.version}`} hint={`v${info.version} · ${info.node_env}`} />
        <StatCard label="运行时长" value={formatUptime(info.started_at)} hint={new Date(info.started_at).toLocaleString()} />
        <StatCard label="数据库" value={info.db_path} hint={info.db_ok ? '可查询' : '查询失败'} />
        <StatCard label="设备在线" value={`${info.health.online_devices}/${info.counts.devices}`} hint="按各采集器调度周期动态判定" />
      </section>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Commit" value={shortHash(build?.commit ?? 'unknown')} />
        <StatCard label="Lockfile" value={shortHash(build?.lockfile_sha256 ?? 'unknown')} />
        <StatCard
          label="构建时间"
          value={build ? new Date(build.built_at).toLocaleString() : '—'}
          hint={build
            ? `Build Node ${build.node_version} (${build.architecture ?? 'unknown'}) · Runtime Node ${info.runtime_node_version ?? 'unknown'} (${info.runtime_architecture ?? 'unknown'})`
            : '旧版 Server 未提供构建元数据'}
        />
      </section>
    </>
  )
}

function PricingStatusSection({ rows }: { rows: SystemInfo['pricing_status'] }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-zinc-200">计价状态分布</h3>
      {!rows.length ? <p className="mt-3 text-sm text-zinc-600">暂无用量记录</p> : (
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
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-zinc-200">设备采集</h3>
      {!devices.length ? <p className="mt-3 text-sm text-zinc-600">暂无设备</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-600">
              <tr>
                {['设备', '状态', '最近成功', '记录数'].map(label => (
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
                    {COLLECTOR_LABELS[device.collector_status]}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{formatRelative(device.last_successful_run_at)}</td>
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

function formatAge(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function RecoverySection({ recovery }: { recovery: SystemInfo['recovery'] }) {
  return (
    <section className="border-t border-white/[0.06] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">数据库恢复</h3>
          <p className="mt-1 text-xs text-zinc-600">在线备份、完整性校验与隔离恢复演练</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${RECOVERY_STYLES[recovery.state]}`}>
          {RECOVERY_LABELS[recovery.state]}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="备份年龄" value={formatAge(recovery.age_seconds)} />
        <StatCard label="副本大小" value={formatBytes(recovery.backup_bytes)} />
        <StatCard label="Schema" value={recovery.schema_version == null ? '—' : String(recovery.schema_version)} />
        <StatCard label="完整性" value={CHECK_LABELS[recovery.integrity]} />
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        最近演练：{CHECK_LABELS[recovery.drill.state]}
        {recovery.drill.duration_ms == null ? '' : ` · ${recovery.drill.duration_ms.toLocaleString()} ms`}
        {recovery.last_failure_at ? ` · 最近失败 ${formatRelative(recovery.last_failure_at)}` : ''}
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
  const [preference, setPreference] = useState<BurnPreference>(() => readBurnPreference())
  const options: { value: BurnPreference; label: string; hint: string }[] = [
    { value: 'auto', label: '自动', hint: '按真实 Tokens 调节' },
    { value: 'on', label: '开启', hint: '固定暖光边框' },
    { value: 'off', label: '关闭', hint: '完全不显示' },
  ]
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-zinc-200">燃烧氛围</h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-600">
        全屏热浪装饰；默认自动，阈值基于当前筛选的真实消耗 Tokens（20 万 warm / 500 万 blaze）。
        设置页内始终关闭以免干扰操作。
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
  const { info, loading, error, load } = useSystemInfo()
  if (loading && !info) return <ReadFeedback loading hasData={false} error={null} label="加载系统信息…" onRetry={() => { load() }} />
  if (!info) {
    return <ReadFeedback loading={false} hasData={false} error={error} label="加载系统信息…" onRetry={() => { load() }} />
  }
  return <div className="space-y-5">
    <ReadFeedback loading={loading} hasData error={error} label="加载系统信息…" onRetry={() => { load() }} />
    <PanelHeader info={info} refresh={() => { load().catch(() => {}) }} />
    <RuntimeCards info={info} />
    <BurnFxSection />
    <RecoverySection recovery={info.recovery} />
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard label="设备数" value={String(info.counts.devices)} />
      <StatCard label="用量记录" value={info.counts.usage_records.toLocaleString()} />
      <StatCard label="计价规则" value={String(info.counts.pricing_rules)} />
    </section>
    {info.health.notes.length > 0 ? <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/90">
      <p className="font-medium">健康提示</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-100/80">{info.health.notes.map(note => <li key={note}>{note}</li>)}</ul>
    </section> : null}
    <PricingStatusSection rows={info.pricing_status} />
    <DeviceCollectorSection devices={info.devices} />
  </div>
}
