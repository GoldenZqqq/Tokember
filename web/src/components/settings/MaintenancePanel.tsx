import { useEffect, useState } from 'react'
import {
  adminApi,
  type MaintenanceActionResult,
  type MaintenanceSummary,
  type PricingRule,
  type RepriceResult,
} from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { useT } from '../../i18n'
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
  const t = useT()
  const compatible = rules.filter(rule => rule.enabled
    && (rule.source == null || rule.source === row.provider))
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <select
        value={targetId}
        onChange={event => onTarget(Number(event.target.value))}
        className="field-input min-w-0"
        aria-label={t('settingsUi.selectTargetAria', { model: row.model })}
      >
        <option value={0}>{t('settingsUi.selectPricingModel')}</option>
        {compatible.map(rule => (
          <option key={rule.id} value={rule.id}>
            {rule.model}{rule.source ? ` (${providerDisplayName(rule.source)})` : ` (${t('settingsUi.global')})`}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !targetId}
        onClick={onClassify}
        className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-orange-400 disabled:opacity-40"
      >{t('settingsUi.classify')}</button>
    </div>
  )
}

export function MaintenancePanel() {
  const t = useT()
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
    setMessage(reason instanceof Error ? reason.message : t('common.operationsFailed'))
  }

  async function reprice(apply: boolean) {
    setBusy(true)
    try {
      const result = await adminApi.reprice(apply)
      setPreview(result)
      if (apply) {
        setMessage(t('settingsUi.appliedReprice', {
          n: result.matched, delta: result.cost_delta.toFixed(4),
        }))
        await load(pattern, true)
      } else {
        setMessage(t('settingsUi.previewReprice', {
          n: result.matched, delta: result.cost_delta.toFixed(4),
        }))
      }
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function ignorePlaceholders() {
    if (!window.confirm(t('settingsUi.confirmIgnore', { pattern }))) return
    setBusy(true)
    try {
      const result: MaintenanceActionResult = await adminApi.ignoreUnpriced(pattern)
      setMessage(t('settingsUi.ignoredRecords', { n: result.affected, pattern: result.pattern }))
      await load(pattern, true)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function restorePlaceholders() {
    if (!window.confirm(t('settingsUi.confirmRestore', { pattern }))) return
    setBusy(true)
    try {
      const result = await adminApi.restoreIgnored({ pattern })
      setMessage(t('settingsUi.restoredRecords', { n: result.affected, pattern: result.pattern }))
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
      setMessage(t('settingsUi.classifiedReprice', {
        alias: result.alias, model: result.model, n: result.repriced,
        delta: result.cost_delta.toFixed(4),
      }))
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
      label={t('maintenanceUi.loading')} onRetry={() => { load() }}
    />
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-400">Data Maintenance</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">{t('maintenanceUi.title')}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          {t('maintenanceUi.subtitle')}
        </p>
      </header>

      <ReadFeedback
        loading={loading} hasData={summary != null} error={loadError}
        label={t('maintenanceUi.loading')} onRetry={() => { load() }}
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('maintenanceUi.unpriced')} value={String(summary?.unpriced_count ?? 0)} hint="pricing_status = unpriced" />
        <StatCard label={t('maintenanceUi.repriceable')} value={String(preview?.matched ?? summary?.reprice.matched ?? 0)} hint={t('maintenanceUi.repriceableHint')} />
        <StatCard
          label={t('maintenanceUi.placeholderUnpriced')}
          value={String(summary?.placeholder_unpriced_count ?? 0)}
          hint={pattern}
        />
        <StatCard label={t('maintenanceUi.ignored')} value={String(summary?.ignored_count ?? 0)} hint={t('maintenanceUi.ignoredHint')} />
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">{t('maintenanceUi.historicalReprice')}</h3>
            <p className="mt-1 text-xs text-zinc-600">
              {t('maintenanceUi.repriceHint')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => reprice(false)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] disabled:opacity-40"
            >
              {t('maintenanceUi.previewReprice')}
            </button>
            <button
              type="button"
              disabled={busy || !preview || preview.matched === 0}
              onClick={() => reprice(true)}
              className="rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {t('maintenanceUi.applyReprice')}
            </button>
          </div>
        </div>
        {preview ? (
          <p className="mt-3 text-sm text-zinc-400">
            {t('maintenanceUi.matchPreview', {
              n: preview.matched,
              delta: `$${preview.cost_delta.toFixed(4)}`,
              suffix: preview.applied ? t('maintenanceUi.appliedSuffix') : t('maintenanceUi.previewSuffix'),
            })}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <h3 className="text-sm font-semibold text-zinc-200">{t('maintenanceUi.placeholderIgnore')}</h3>
        <p className="mt-1 text-xs text-zinc-600">
          {t('maintenanceUi.placeholderHint')}
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
              {t('maintenanceUi.refreshStats')}
            </button>
            <button
              type="button"
              disabled={busy || (summary?.placeholder_unpriced_count ?? 0) === 0}
              onClick={ignorePlaceholders}
              className="rounded-lg bg-orange-500/90 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {t('maintenanceUi.ignoreMatching')}
            </button>
            <button
              type="button"
              disabled={busy || (summary?.ignored_count ?? 0) === 0}
              onClick={restorePlaceholders}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] disabled:opacity-40"
            >
              {t('maintenanceUi.restoreMatching')}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <h3 className="text-sm font-semibold text-zinc-200">{t('maintenanceUi.unpricedTop')}</h3>
        {!summary?.by_model.length ? (
          <p className="mt-3 text-sm text-zinc-600">{t('maintenanceUi.noUnpriced')}</p>
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
                      {t('maintenanceUi.rows', { n: row.count.toLocaleString() })}
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
                  <th className="pb-2 pr-4 font-medium">{t('maintenanceUi.model')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('maintenanceUi.source')}</th>
                  <th className="pb-2 font-medium">{t('maintenanceUi.count')}</th>
                  <th className="pb-2 pl-4 font-medium">{t('maintenanceUi.classifyInto')}</th>
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
