import { useEffect, useRef, useState } from 'react'
import type {
  AlertCenterResponse,
  AlertEvent,
  AlertRuleInput,
  AlertRuleWithEvaluation,
} from '@tokember/contracts/alerts'
import type { DeviceSummary } from '../../admin/types'
import { adminApi } from '../../admin/api'
import { isAbortError, toApiError } from '../../data/api-client'
import { LatestRequest } from '../../data/latest-request'
import {
  beginResource, failResource, initialResource, succeedResource,
  type ResourceState,
} from '../../data/resource-state'
import { providerDisplayName } from '../../provider-display'
import { ResourceView } from '../ResourceView'
import { AlertRuleForm, defaultAlertRuleInput, editableAlertRule } from './AlertRuleForm'

interface AlertPanelData {
  center: AlertCenterResponse
  devices: DeviceSummary[]
}

const RULE_LABELS = {
  budget: '预算阈值', spike: '历史突增',
  source_health: '来源健康', unpriced_growth: '未计价增长',
}

function localTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

function metric(value: number, kind: 'cost' | 'tokens'): string {
  return kind === 'cost' ? `$${value.toFixed(2)}` : value.toLocaleString('zh-CN')
}

export function evidenceLines(event: AlertEvent): string[] {
  const evidence = event.evidence
  if (evidence.kind === 'budget') return [
    `已用 ${metric(evidence.used, evidence.metric)} / ${metric(evidence.limit, evidence.metric)}`,
    `比例 ${(evidence.ratio * 100).toFixed(1)}% · 预测 ${metric(evidence.forecast, evidence.metric)}`,
    `${localTime(evidence.window.since)} – ${localTime(evidence.window.until)}`,
    ...(evidence.forecast_incomplete ? ['成本预测不完整：窗口内存在未计价用量'] : []),
  ]
  if (evidence.kind === 'spike') return [
    `预测 ${metric(evidence.forecast, evidence.metric)} · 基线 ${metric(evidence.baseline, evidence.metric)}`,
    `达到基线 ${evidence.multiplier.toFixed(2)} 倍 · ${evidence.sample_days} 个完整日`,
    `${localTime(evidence.baseline_window.since)} – ${localTime(evidence.window.until)}`,
    ...(evidence.forecast_incomplete ? ['成本预测不完整：窗口内存在未计价用量'] : []),
  ]
  if (evidence.kind === 'source_health') return [
    `${evidence.device_id} · ${evidence.source ? providerDisplayName(evidence.source) : '全部来源'} · ${evidence.state}`,
    `连续失败 ${evidence.consecutive_failures} 次 · 过期阈值 ${evidence.stale_minutes} 分钟`,
    `最近运行 ${localTime(evidence.last_run_at)}`,
  ]
  return [
    `当前未计价 ${(evidence.current_ratio * 100).toFixed(1)}% · 基线 ${(evidence.baseline_ratio * 100).toFixed(1)}%`,
    `增长 ${(evidence.increase_ratio * 100).toFixed(1)} pp · ${evidence.sample_days} 个完整日`,
    `${evidence.unpriced_tokens.toLocaleString('zh-CN')} / ${evidence.total_tokens.toLocaleString('zh-CN')} Tokens`,
  ]
}

function Summary({ center }: { center: AlertCenterResponse }) {
  const active = center.events.filter(event => event.status === 'active').length
  const enabled = center.rules.filter(rule => rule.enabled).length
  return <div className="grid grid-cols-3 divide-x divide-white/[0.06] rounded-xl border border-white/[0.06] bg-white/[0.015]">
    <SummaryValue label="活动告警" value={String(active)} tone={active ? 'text-orange-300' : 'text-zinc-200'} />
    <SummaryValue label="启用规则" value={`${enabled}/${center.rules.length}`} tone="text-blue-300" />
    <SummaryValue label="Webhook" value={center.webhook_configured ? '已配置' : '未配置'}
      tone={center.webhook_configured ? 'text-emerald-300' : 'text-zinc-500'} />
  </div>
}

function SummaryValue({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className="min-w-0 px-3 py-4 text-center"><p className="text-[11px] text-zinc-600">{label}</p>
    <p className={`mt-1 truncate text-lg font-semibold tabular-nums ${tone}`}>{value}</p></div>
}

function EvaluationBadge({ rule }: { rule: AlertRuleWithEvaluation }) {
  const evaluation = rule.evaluation
  if (!evaluation) return <span className="text-xs text-zinc-600">尚未评估</span>
  const tone = evaluation.status === 'triggered' ? 'text-orange-300'
    : evaluation.status === 'insufficient_data' ? 'text-amber-300'
      : evaluation.status === 'error' ? 'text-red-300' : 'text-emerald-300'
  return <span className={`text-xs ${tone}`}>{evaluation.reason}</span>
}

function RulesSection({ rules, busy, onEdit, onToggle, onCreate }: {
  rules: AlertRuleWithEvaluation[]
  busy: boolean
  onEdit: (rule: AlertRuleWithEvaluation) => void
  onToggle: (rule: AlertRuleWithEvaluation) => void
  onCreate: () => void
}) {
  return <section className="space-y-3"><div className="flex items-center justify-between gap-3">
    <div><h3 className="text-sm font-semibold text-zinc-200">规则</h3>
      <p className="mt-1 text-xs text-zinc-600">评估状态会保留数据不足与错误原因。</p></div>
    <button type="button" onClick={onCreate}
      className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-black hover:bg-orange-400">新增规则</button>
  </div>
    {rules.length === 0 ? <p className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">尚未配置规则</p>
      : <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.06]">
        {rules.map(rule => <div key={rule.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-200">{rule.name}</span>
            <span className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-zinc-500">{RULE_LABELS[rule.kind]}</span>
            {!rule.enabled ? <span className="text-[10px] text-zinc-600">已停用</span> : null}
          </div><p className="mt-1 text-xs text-zinc-600">{rule.device_id ?? '全部设备'} · {rule.provider ? providerDisplayName(rule.provider) : '全部来源'} · {rule.timezone}</p>
            <p className="mt-1"><EvaluationBadge rule={rule} /></p></div>
          <div className="flex shrink-0 gap-2"><button type="button" onClick={() => onEdit(rule)}
            className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-white/[0.05]">编辑</button>
            <button type="button" disabled={busy} onClick={() => onToggle(rule)}
              className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 disabled:opacity-50">
              {rule.enabled ? '停用' : '启用'}
            </button></div>
        </div>)}
      </div>}
  </section>
}

function EventRow({ event, busy, onAcknowledge }: {
  event: AlertEvent
  busy: boolean
  onAcknowledge: (event: AlertEvent) => void
}) {
  const active = event.status === 'active'
  const tone = event.severity === 'critical' ? 'border-red-500/25'
    : event.severity === 'warning' ? 'border-orange-500/25' : 'border-blue-500/20'
  return <article className={`rounded-xl border bg-white/[0.015] p-4 ${tone}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div>
      <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium text-zinc-200">{event.rule_name}</h4>
        <span className={active ? 'text-xs text-orange-300' : 'text-xs text-emerald-300'}>{active ? '活动中' : '已恢复'}</span>
        {event.acknowledged_at ? <span className="text-xs text-zinc-600">已确认</span> : null}</div>
      <p className="mt-1 text-xs text-zinc-600">首次 {localTime(event.first_triggered_at)} · 最后 {localTime(event.last_triggered_at)}</p>
    </div>{!event.acknowledged_at ? <button type="button" disabled={busy}
      onClick={() => onAcknowledge(event)}
      className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 disabled:opacity-50">确认</button> : null}</div>
    <ul className="mt-3 space-y-1 text-xs text-zinc-400">{evidenceLines(event).map(line => <li key={line}>{line}</li>)}</ul>
    <p className="mt-3 text-[11px] text-zinc-600">通知：{event.notification_status}</p>
  </article>
}

function EventsSection({ events, busy, onAcknowledge }: {
  events: AlertEvent[]
  busy: boolean
  onAcknowledge: (event: AlertEvent) => void
}) {
  return <section><div><h3 className="text-sm font-semibold text-zinc-200">事件</h3>
    <p className="mt-1 text-xs text-zinc-600">确认用于人工处理记录，恢复由真实条件决定。</p></div>
    <div className="mt-3 space-y-3">{events.length
      ? events.map(event => <EventRow key={event.id} event={event} busy={busy} onAcknowledge={onAcknowledge} />)
      : <p className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">还没有告警事件</p>}</div>
  </section>
}

export function AlertCenterContent({ data, busy, onEdit, onToggle, onCreate, onAcknowledge }: {
  data: AlertPanelData
  busy: boolean
  onEdit: (rule: AlertRuleWithEvaluation) => void
  onToggle: (rule: AlertRuleWithEvaluation) => void
  onCreate: () => void
  onAcknowledge: (event: AlertEvent) => void
}) {
  return <div className="space-y-6"><Summary center={data.center} />
    <RulesSection rules={data.center.rules} busy={busy} onEdit={onEdit}
      onToggle={onToggle} onCreate={onCreate} />
    <EventsSection events={data.center.events} busy={busy} onAcknowledge={onAcknowledge} />
  </div>
}

function AlertPanelView({
  state, draft, editingId, showForm, busy, actionError,
  onDraft, onSave, onCancel, onLoad, onEvaluate, onEdit, onToggle, onCreate, onAcknowledge,
}: {
  state: ResourceState<AlertPanelData>
  draft: AlertRuleInput
  editingId: number | null
  showForm: boolean
  busy: boolean
  actionError: string
  onDraft: (value: AlertRuleInput) => void
  onSave: () => void
  onCancel: () => void
  onLoad: () => void
  onEvaluate: () => void
  onEdit: (rule: AlertRuleWithEvaluation) => void
  onToggle: (rule: AlertRuleWithEvaluation) => void
  onCreate: () => void
  onAcknowledge: (event: AlertEvent) => void
}) {
  const data = state.data
  return <section className="space-y-5"><header className="flex flex-wrap items-start justify-between gap-3">
    <div><h2 className="text-lg font-semibold text-zinc-100">告警中心</h2>
      <p className="mt-1 text-sm text-zinc-500">预算、异常增长与采集健康，只在管理后台展示。</p></div>
    <div className="flex gap-2"><button type="button" disabled={busy} onClick={onEvaluate}
      className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-700 disabled:opacity-50">立即评估</button>
      <button type="button" disabled={busy} onClick={onLoad}
        className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:bg-white/[0.05] disabled:opacity-50">刷新</button></div>
  </header>
    {actionError ? <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{actionError}</p> : null}
    {showForm ? <AlertRuleForm value={draft} devices={data?.devices ?? []}
      editing={editingId != null} saving={busy} onChange={onDraft}
      onSubmit={onSave} onCancel={onCancel} /> : null}
    <ResourceView status={state.status} error={state.error} empty={false}
      loadingLabel="加载告警中心…" emptyLabel="" onRetry={onLoad}>
      {data ? <AlertCenterContent data={data} busy={busy} onEdit={onEdit}
        onCreate={onCreate} onToggle={onToggle} onAcknowledge={onAcknowledge} /> : null}
    </ResourceView>
  </section>
}

export function AlertCenterPanel() {
  const latest = useRef(new LatestRequest())
  const [state, setState] = useState<ResourceState<AlertPanelData>>(initialResource)
  const [draft, setDraft] = useState<AlertRuleInput>(defaultAlertRuleInput)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const load = async () => {
    setState(current => beginResource(current, 'alerts'))
    try {
      const result = await latest.current.execute(async signal => {
        const [center, devices] = await Promise.all([adminApi.alerts(signal), adminApi.devices()])
        return { center, devices: devices.devices }
      })
      if (result.current) setState(current => succeedResource(current, 'alerts', result.value!))
    } catch (error) {
      if (!isAbortError(error)) setState(current => failResource(current, 'alerts', toApiError(error)))
    }
  }
  useEffect(() => { load(); return () => latest.current.cancel() }, [])
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setActionError('')
    try { await action(); await load(); return true }
    catch (error) { setActionError(toApiError(error).message); return false }
    finally { setBusy(false) }
  }
  const edit = (rule: AlertRuleWithEvaluation) => {
    setDraft(editableAlertRule(rule)); setEditingId(rule.id); setShowForm(true)
  }
  const resetForm = () => {
    setDraft(defaultAlertRuleInput()); setEditingId(null); setShowForm(false)
  }
  const save = async () => {
    const saved = await perform(() => editingId
      ? adminApi.updateAlertRule(editingId, draft)
      : adminApi.createAlertRule(draft))
    if (saved) resetForm()
  }
  return <AlertPanelView state={state} draft={draft} editingId={editingId}
    showForm={showForm} busy={busy} actionError={actionError}
    onDraft={setDraft} onSave={() => { void save() }} onCancel={resetForm}
    onLoad={() => { void load() }} onEvaluate={() => { void perform(() => adminApi.evaluateAlerts()) }}
    onEdit={edit} onCreate={() => {
      setDraft(defaultAlertRuleInput()); setEditingId(null); setShowForm(true)
    }}
    onToggle={rule => { void perform(() => adminApi.setAlertRuleEnabled(rule.id, !rule.enabled)) }}
    onAcknowledge={event => { void perform(() => adminApi.acknowledgeAlert(event.id)) }} />
}
