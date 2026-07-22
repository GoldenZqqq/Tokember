import { useEffect, useState } from 'react'
import {
  adminApi,
  type MaintenanceActionResult,
  type MaintenanceSummary,
  type PricingRule,
  type RepriceResult,
} from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { providerDisplayName } from '../../provider-display'
import { ReadFeedback } from '../ReadFeedback'

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-100">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  )
}

type UnpricedModel = MaintenanceSummary['by_model'][number]

function ClassificationControl({
  row, rules, targetId, busy, onTarget, onClassify,
}: {
  row: UnpricedModel
  rules: PricingRule[]
  targetId: number
  busy: boolean
  onTarget: (ruleId: number) => void
  onClassify: () => void
}) {
  const compatible = rules.filter(rule => rule.enabled
    && (rule.source == null || rule.source === row.provider))
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <select
        value={targetId}
        onChange={event => onTarget(Number(event.target.value))}
        className="field-input min-w-0"
        aria-label={`选择 ${row.model} 的目标模型`}
      >
        <option value={0}>选择计价模型</option>
        {compatible.map(rule => (
          <option key={rule.id} value={rule.id}>
            {rule.model}{rule.source ? ` (${providerDisplayName(rule.source)})` : ' (全局)'}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !targetId}
        onClick={onClassify}
        className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-orange-400 disabled:opacity-40"
      >归入</button>
    </div>
  )
}

export function MaintenancePanel() {
  const [summary, setSummary] = useState<MaintenanceSummary | null>(null)
  const [rules, setRules] = useState<PricingRule[]>([])
  const [targets, setTargets] = useState<Record<string, number>>({})
  const [pattern, setPattern] = useState('MODEL_PLACEHOLDER_*')
  const [preview, setPreview] = useState<RepriceResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [loadError, setLoadError] = useState<ApiError | null>(null)

  async function load(nextPattern = pattern, preserveMessage = false) {
    setLoading(true)
    setLoadError(null)
    try {
      const [data, ruleData] = await Promise.all([
        adminApi.maintenanceSummary(nextPattern),
        adminApi.rules(),
      ])
      setSummary(data)
      setRules(ruleData.rules)
      setPreview(data.reprice)
      setPattern(data.default_pattern || nextPattern)
      if (!preserveMessage) setMessage('')
    } catch (reason) {
      setLoadError(toApiError(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load().catch(() => {}) }, [])

  function showError(reason: unknown) {
    setMessage(reason instanceof Error ? reason.message : '操作失败')
  }

  async function reprice(apply: boolean) {
    setBusy(true)
    try {
      const result = await adminApi.reprice(apply)
      setPreview(result)
      if (apply) {
        setMessage(`已补价 ${result.matched} 条记录，成本 +$${result.cost_delta.toFixed(4)}`)
        await load(pattern, true)
      } else {
        setMessage(`预览：可补价 ${result.matched} 条，预计 +$${result.cost_delta.toFixed(4)}`)
      }
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function ignorePlaceholders() {
    if (!window.confirm(`确认将匹配「${pattern}」的未计价记录标记为忽略？\n这些记录将不再出现在未计价统计与补价候选中。`)) return
    setBusy(true)
    try {
      const result: MaintenanceActionResult = await adminApi.ignoreUnpriced(pattern)
      setMessage(`已忽略 ${result.affected} 条记录（模式 ${result.pattern}）`)
      await load(pattern, true)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function restorePlaceholders() {
    if (!window.confirm(`确认将匹配「${pattern}」的已忽略记录恢复为未计价？`)) return
    setBusy(true)
    try {
      const result = await adminApi.restoreIgnored({ pattern })
      setMessage(`已恢复 ${result.affected} 条记录（模式 ${result.pattern}）`)
      await load(pattern, true)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function classifyModel(row: MaintenanceSummary['by_model'][number]) {
    const key = `${row.provider}:${row.model}`
    const ruleId = targets[key]
    if (!ruleId) return
    setBusy(true)
    try {
      const result = await adminApi.classifyModel(row.provider, row.model, ruleId)
      setMessage(`已将 ${result.alias} 归入 ${result.model}，补价 ${result.repriced} 条，费用 +$${result.cost_delta.toFixed(4)}`)
      await load(pattern, true)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  if (!summary && (loading || loadError)) {
    return <ReadFeedback
      loading={loading} hasData={false} error={loadError}
      label="加载维护摘要…" onRetry={() => { load() }}
    />
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-400">Data Maintenance</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">数据维护</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          查看未计价用量、执行历史补价，并将无法识别的占位模型标记为忽略，避免污染未计价指标。
        </p>
      </header>

      <ReadFeedback
        loading={loading} hasData={summary != null} error={loadError}
        label="加载维护摘要…" onRetry={() => { load() }}
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="未计价" value={String(summary?.unpriced_count ?? 0)} hint="pricing_status = unpriced" />
        <StatCard label="可补价" value={String(preview?.matched ?? summary?.reprice.matched ?? 0)} hint="已有规则可匹配" />
        <StatCard
          label="占位未计价"
          value={String(summary?.placeholder_unpriced_count ?? 0)}
          hint={pattern}
        />
        <StatCard label="已忽略" value={String(summary?.ignored_count ?? 0)} hint="不参与补价与未计价" />
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">历史补价</h3>
            <p className="mt-1 text-xs text-zinc-600">
              仅处理未计价记录；采集器实报成本与已计价记录不会被覆盖。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => reprice(false)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] disabled:opacity-40"
            >
              预览补价
            </button>
            <button
              type="button"
              disabled={busy || !preview || preview.matched === 0}
              onClick={() => reprice(true)}
              className="rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              应用补价
            </button>
          </div>
        </div>
        {preview ? (
          <p className="mt-3 text-sm text-zinc-400">
            匹配 <span className="tabular-nums text-zinc-200">{preview.matched}</span> 条，
            预计成本增量 <span className="tabular-nums text-orange-300">${preview.cost_delta.toFixed(4)}</span>
            {preview.applied ? '（已应用）' : '（预览）'}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <h3 className="text-sm font-semibold text-zinc-200">占位模型忽略</h3>
        <p className="mt-1 text-xs text-zinc-600">
          默认忽略 Antigravity 等无法识别的 MODEL_PLACEHOLDER_* 记录。
          模式使用 SQLite GLOB：* 匹配任意长度。
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-orange-500/40"
            placeholder="MODEL_PLACEHOLDER_*"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => load(pattern)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] disabled:opacity-40"
            >
              刷新统计
            </button>
            <button
              type="button"
              disabled={busy || (summary?.placeholder_unpriced_count ?? 0) === 0}
              onClick={ignorePlaceholders}
              className="rounded-lg bg-orange-500/90 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              忽略匹配未计价
            </button>
            <button
              type="button"
              disabled={busy || (summary?.ignored_count ?? 0) === 0}
              onClick={restorePlaceholders}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] disabled:opacity-40"
            >
              恢复匹配忽略
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <h3 className="text-sm font-semibold text-zinc-200">未计价模型 Top</h3>
        {!summary?.by_model.length ? (
          <p className="mt-3 text-sm text-zinc-600">当前没有未计价记录。</p>
        ) : (
          <>
          <div className="mt-3 divide-y divide-white/[0.04] md:hidden">
            {summary.by_model.map(row => {
              const key = `${row.provider}:${row.model}`
              return (
                <div key={key} className="py-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-zinc-100">{row.model}</p>
                      <p className="mt-1 text-xs text-zinc-500">{row.provider ? providerDisplayName(row.provider) : '—'}</p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums text-zinc-300">
                      {row.count.toLocaleString()} 条
                    </span>
                  </div>
                  <div className="mt-3">
                    <ClassificationControl
                      row={row}
                      rules={rules}
                      targetId={targets[key] ?? 0}
                      busy={busy}
                      onTarget={ruleId => setTargets(current => ({ ...current, [key]: ruleId }))}
                      onClassify={() => classifyModel(row)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-600">
                <tr>
                  <th className="pb-2 pr-4 font-medium">模型</th>
                  <th className="pb-2 pr-4 font-medium">来源</th>
                  <th className="pb-2 font-medium">条数</th>
                  <th className="pb-2 pl-4 font-medium">归入现有模型</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {summary.by_model.map(row => {
                  const key = `${row.provider}:${row.model}`
                  return (
                    <tr key={key} className="text-zinc-300">
                      <td className="py-2 pr-4 font-medium text-zinc-100">{row.model}</td>
                      <td className="py-2 pr-4 text-zinc-500">{row.provider ? providerDisplayName(row.provider) : '—'}</td>
                      <td className="py-2 tabular-nums">{row.count.toLocaleString()}</td>
                      <td className="py-2 pl-4">
                        <div className="min-w-[22rem]">
                          <ClassificationControl
                            row={row}
                            rules={rules}
                            targetId={targets[key] ?? 0}
                            busy={busy}
                            onTarget={ruleId => setTargets(current => ({ ...current, [key]: ruleId }))}
                            onClassify={() => classifyModel(row)}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>

      {message ? (
        <p className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-zinc-300">
          {message}
        </p>
      ) : null}
    </div>
  )
}
