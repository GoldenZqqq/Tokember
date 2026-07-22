import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuditAdminRecord,
  AuditCutoverPage,
  AuditReconciliationResponse,
  AuditRecordsPage,
  AuditSummaryResponse,
} from '../../admin/api'
import { adminApi } from '../../admin/api'
import {
  auditSearchParams,
  filtersFromHash,
  withSnapshot,
  type AuditFilters,
} from '../../audit/query'
import { isAbortError, toApiError } from '../../data/api-client'
import { LatestRequest } from '../../data/latest-request'
import {
  beginResource, failResource, initialResource, succeedResource,
  type ResourceState,
} from '../../data/resource-state'
import { providerDisplayName } from '../../provider-display'
import { ReadFeedback } from '../ReadFeedback'

interface AuditViewData {
  filters: AuditFilters
  page: AuditRecordsPage<AuditAdminRecord>
  summary: AuditSummaryResponse
  reconciliation: AuditReconciliationResponse
  cutovers: AuditCutoverPage
}

function number(value: number): string {
  return value.toLocaleString('zh-CN')
}

function timestamp(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN') : value
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="min-w-0 text-xs text-zinc-500">
    <span className="mb-1.5 block">{label}</span>
    {children}
  </label>
}

interface FilterFormProps {
  value: AuditFilters
  onChange: (value: AuditFilters) => void
  onApply: () => void
  onRefreshSnapshot: () => void
}

function TextFilter({
  label, value, placeholder, onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return <Field label={label}>
    <input className="field-input" value={value} onChange={event => onChange(event.target.value)}
      placeholder={placeholder} />
  </Field>
}

function AuditFilterGrid({ value, onChange }: Pick<FilterFormProps, 'value' | 'onChange'>) {
  const update = (field: keyof AuditFilters, next: string) => {
    onChange({ ...value, [field]: next || undefined })
  }
  return <>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <TextFilter label="开始时间（UTC ISO）" value={value.since}
        onChange={next => update('since', next)} />
      <TextFilter label="结束时间（UTC ISO）" value={value.until}
        onChange={next => update('until', next)} />
      <TextFilter label="设备 ID" value={value.device ?? ''} placeholder="全部设备"
        onChange={next => update('device', next)} />
      <TextFilter label="来源" value={value.provider ?? ''} placeholder="全部来源"
        onChange={next => update('provider', next)} />
      <TextFilter label="模型" value={value.model ?? ''} placeholder="全部模型"
        onChange={next => update('model', next)} />
      <Field label="计价状态">
        <select className="field-input" value={value.pricing_status ?? ''}
          onChange={event => update('pricing_status', event.target.value)}>
          <option value="">全部状态</option>
          {['provided', 'priced', 'free', 'included', 'unpriced', 'none', 'ignored']
            .map(status => <option key={status} value={status}>{status}</option>)}
        </select>
      </Field>
      <TextFilter label="来源标记" value={value.source_marker ?? ''} placeholder="精确匹配"
        onChange={next => update('source_marker', next)} />
      <TextFilter label="Dedup Key" value={value.dedup_key ?? ''} placeholder="精确匹配"
        onChange={next => update('dedup_key', next)} />
      <TextFilter label="项目组 ID" value={value.project_group_id?.toString() ?? ''}
        placeholder="全部项目" onChange={next => onChange({
          ...value,
          project_group_id: Number.isSafeInteger(Number(next)) && Number(next) > 0
            ? Number(next) : undefined,
        })} />
      <TextFilter label="会话 ID" value={value.session_id ?? ''} placeholder="精确匹配"
        onChange={next => update('session_id', next)} />
    </div>
    <div className="mt-4 max-w-44">
      <Field label="记录口径">
        <select className="field-input" value={value.visibility}
          onChange={event => update('visibility', event.target.value)}>
          <option value="authoritative">权威记录</option>
          <option value="physical">全部物理记录</option>
          <option value="hidden">被隐藏记录</option>
        </select>
      </Field>
    </div>
  </>
}

function FilterActions({ onRefreshSnapshot }: Pick<FilterFormProps, 'onRefreshSnapshot'>) {
  return <div className="flex flex-wrap gap-2">
    <button type="button" onClick={onRefreshSnapshot}
      className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.05] focus-visible:outline-2 focus-visible:outline-orange-500">
      刷新快照
    </button>
    <button type="submit"
      className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-black hover:bg-orange-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500">
      应用筛选
    </button>
  </div>
}

function AuditFiltersForm(props: FilterFormProps) {
  return <form className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
    onSubmit={event => { event.preventDefault(); props.onApply() }}>
    <AuditFilterGrid value={props.value} onChange={props.onChange} />
    <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
      <p className="text-xs text-zinc-600">筛选默认保持当前 Ledger 快照。</p>
      <FilterActions onRefreshSnapshot={props.onRefreshSnapshot} />
    </div>
  </form>
}

function SummaryStrip({ summary }: { summary: AuditSummaryResponse }) {
  const rows = [
    ['当前口径', summary.selected], ['权威记录', summary.authoritative],
    ['物理记录', summary.physical], ['隐藏记录', summary.hidden],
  ] as const
  return <section className="overflow-hidden rounded-xl border border-white/[0.06]">
    <div className="grid grid-cols-2 divide-x divide-y divide-white/[0.06] lg:grid-cols-4 lg:divide-y-0">
      {rows.map(([label, value]) => <div key={label} className="min-w-0 bg-white/[0.02] p-4">
        <p className="text-xs text-zinc-500">{label}</p>
        <p className="mt-2 text-lg font-semibold tabular-nums text-zinc-100">
          ${value.cost_usd.toFixed(3)}
        </p>
        <p className="mt-1 text-xs tabular-nums text-zinc-500">
          {number(value.calls)} Calls · {number(value.real_total_tokens)} Tokens · {number(value.records)} 行
        </p>
      </div>)}
    </div>
  </section>
}

function StatusPill({ record }: { record: AuditAdminRecord }) {
  const exact = record.pricing_explanation.status === 'exact'
  const label = record.is_authoritative ? '权威' : '隐藏'
  return <span className={`rounded-full px-2 py-1 text-[11px] ${
    record.is_authoritative ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
  }`}>{label} · {exact ? record.pricing_status : record.pricing_explanation.status}</span>
}

function RecordDetail({ record }: { record: AuditAdminRecord }) {
  const rule = record.pricing_explanation.current_rule
  return <details className="border-t border-white/[0.05] px-4 py-3">
    <summary className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-200">
      查看 Token、计价与来源证据
    </summary>
    <div className="mt-3 grid gap-4 text-xs text-zinc-400 lg:grid-cols-3">
      <div>
        <p className="font-medium text-zinc-300">Token 构成</p>
        <p className="mt-2 leading-6 tabular-nums">
          原始输入 {number(record.input_tokens)} / fresh {number(record.fresh_input_tokens)}<br />
          原始输出 {number(record.output_tokens)} / billable {number(record.billable_output_tokens)}<br />
          cache read {number(record.cache_read_tokens)} / write {number(record.cache_creation_tokens)}<br />
          reasoning {number(record.reasoning_tokens)} / real total {number(record.real_total_tokens)}
        </p>
      </div>
      <div className="min-w-0">
        <p className="font-medium text-zinc-300">来源证据</p>
        <p className="mt-2 break-all leading-6">
          source: {record.source_file ?? '—'}<br />dedup: {record.dedup_key ?? '—'}<br />
          pricing: {record.pricing_source ?? '—'} / rule {record.pricing_rule_id ?? '—'}
        </p>
      </div>
      <div>
        <p className="font-medium text-zinc-300">成本解释</p>
        <p className="mt-2 leading-6">
          {record.pricing_explanation.status} · 当前复算 {
            record.pricing_explanation.recomputed_cost_usd == null
              ? '—' : `$${record.pricing_explanation.recomputed_cost_usd.toFixed(6)}`
          }<br />
          {rule ? `${rule.model} · ${rule.mode} · ${rule.aliases.length} aliases` : '没有可用的当前规则'}<br />
          历史原始 alias 未持久化，不做推断。
        </p>
      </div>
      <div className="min-w-0">
        <p className="font-medium text-zinc-300">匿名归因</p>
        <p className="mt-2 break-all leading-6">
          状态 {record.attribution_status} / v{record.attribution_version ?? '—'}<br />
          项目 {record.project_name ?? record.project_id ?? '—'}<br />
          group {record.project_group_id ?? '—'} / session {record.session_id ?? '—'}
        </p>
      </div>
    </div>
  </details>
}

function RecordList({ rows }: { rows: AuditAdminRecord[] }) {
  if (!rows.length) return <p className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-zinc-500">当前快照和筛选条件下没有记录。</p>
  return <section className="overflow-hidden rounded-xl border border-white/[0.06]">
    {rows.map(record => <article key={record.id} className="border-b border-white/[0.06] bg-white/[0.015] last:border-0">
      <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] md:items-center">
        <div className="min-w-0">
          <p className="break-words font-mono text-xs font-medium text-zinc-200">{record.model}</p>
          <p className="mt-1 text-xs text-zinc-500">{record.device_name} · {providerDisplayName(record.provider)} · {timestamp(record.timestamp)}</p>
          {record.project_name ? <p className="mt-1 truncate text-xs text-zinc-600">
            {record.project_name}
          </p> : null}
        </div>
        <p className="text-xs tabular-nums text-zinc-400">
          {number(record.request_count)} Calls · {number(record.real_total_tokens)} Tokens
        </p>
        <p className="text-sm font-semibold tabular-nums text-orange-300">${record.cost_usd.toFixed(4)}</p>
        <StatusPill record={record} />
      </div>
      <RecordDetail record={record} />
    </article>)}
  </section>
}

function Reconciliation({ data }: { data: AuditReconciliationResponse }) {
  return <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
    <h3 className="text-sm font-semibold text-zinc-200">采集管道对账</h3>
    <p className="mt-1 max-w-3xl text-xs leading-5 text-zinc-500">
      emitted = accepted + unchanged 是上传守恒；Ledger 是用量时间快照。accepted 包含新增与更新效果，不等于物理行数。
    </p>
    {data.telemetry_coverage.truncated ? <p className="mt-3 text-xs text-amber-300">
      完整运行明细从 {timestamp(data.telemetry_coverage.coverage_since)} 起保留；更早的健康锚点可能仍在，但当前 Runs 不是完整历史。
    </p> : null}
    {!data.rows.length ? <p className="mt-4 text-sm text-zinc-600">该运行窗口没有来源报告。</p> : (
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-[52rem] w-full text-left text-xs">
          <thead className="text-zinc-600"><tr>
            <th className="pb-2 font-medium">设备 / 来源</th><th className="pb-2 font-medium">Runs</th>
            <th className="pb-2 font-medium">Pipeline</th><th className="pb-2 font-medium">Balance</th>
            <th className="pb-2 font-medium">Ledger</th><th className="pb-2 font-medium">最近用量</th>
          </tr></thead>
          <tbody className="divide-y divide-white/[0.05]">{data.rows.map(row => <tr key={`${row.device_id}:${row.source}`}>
            <td className="py-3 text-zinc-300">{row.device_name} / {providerDisplayName(row.source)}</td>
            <td className="py-3 tabular-nums text-zinc-400">{row.successful_runs} 成功 / {row.failed_runs} 失败</td>
            <td className="py-3 tabular-nums text-zinc-400">
              {row.emitted} emitted · 已知 {row.accepted} + {row.unchanged}
              {row.unknown_acknowledgements ? ` · ${row.unknown_acknowledgements} 次未知` : ''}
            </td>
            <td className={`py-3 tabular-nums ${row.pipeline_balance ? 'text-red-300' : 'text-emerald-300'}`}>{row.pipeline_balance}</td>
            <td className="py-3 tabular-nums text-zinc-400">{row.ledger.records} 行 / {number(row.ledger.real_total_tokens)} Tokens</td>
            <td className="py-3 text-zinc-500">{timestamp(row.ledger.last_usage_at)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    )}
  </section>
}

function CutoverEvents({ data }: { data: AuditCutoverPage }) {
  return <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
    <h3 className="text-sm font-semibold text-zinc-200">来源切换事件</h3>
    {!data.rows.length ? <p className="mt-3 text-sm text-zinc-600">当前设备与来源没有切换事件。</p> : (
      <div className="mt-3 divide-y divide-white/[0.05]">{data.rows.map(event => <div key={event.id} className="py-3 text-xs">
        <div className="flex flex-wrap justify-between gap-2 text-zinc-300">
          <span>{event.device_name} · {providerDisplayName(event.provider)} · {event.actor}</span>
          <span className="text-zinc-600">{timestamp(event.created_at)}</span>
        </div>
        <p className="mt-1 break-words text-zinc-500">{event.previous_cutover_at ?? '无'} → {event.cutover_at ?? '无'} · {event.reason}</p>
      </div>)}</div>
    )}
  </section>
}

function useAuditResource(filters: AuditFilters, cursor: string | null) {
  const [state, setState] = useState<ResourceState<AuditViewData>>(initialResource)
  const latest = useRef(new LatestRequest())
  const key = `${auditSearchParams(filters)}::${cursor ?? 'first'}`
  const load = useCallback(async () => {
    setState(current => beginResource(current, key))
    try {
      const result = await latest.current.execute(async signal => {
        const page = await adminApi.auditRecords(filters, cursor, signal)
        const stable = withSnapshot(filters, page.snapshot)
        const [summary, reconciliation, cutovers] = await Promise.all([
          adminApi.auditSummary(stable, signal),
          adminApi.auditReconciliation(stable, signal),
          adminApi.auditCutovers(stable, signal),
        ])
        return { filters: stable, page, summary, reconciliation, cutovers }
      })
      if (result.current) {
        setState(current => succeedResource(current, key, result.value!))
      }
    } catch (error) {
      if (!isAbortError(error)) setState(current => failResource(current, key, toApiError(error)))
    }
  }, [cursor, key])
  useEffect(() => { load(); return () => latest.current.cancel() }, [load])
  return { state, load }
}

function AuditHeader({ data }: { data: AuditViewData | null }) {
  return <header className="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-zinc-100">用量审计与对账</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-500">在同一 Ledger 快照下追溯 Calls、Tokens、成本、来源权威性与采集管道守恒。</p>
    </div>
    {data ? <p className="text-xs tabular-nums text-zinc-600">
      Snapshot #{data.page.snapshot.max_record_id}<br />{timestamp(data.page.snapshot.until)}
    </p> : null}
  </header>
}

function Pagination({
  data, pageIndex, onPrevious, onNext,
}: {
  data: AuditViewData
  pageIndex: number
  onPrevious: () => void
  onNext: () => void
}) {
  return <div className="flex items-center justify-between">
    <button type="button" disabled={pageIndex === 0} onClick={onPrevious}
      className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 disabled:opacity-30">上一页</button>
    <span className="text-xs text-zinc-600">第 {pageIndex + 1} 页</span>
    <button type="button" disabled={!data.page.next_cursor} onClick={onNext}
      className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 disabled:opacity-30">下一页</button>
  </div>
}

function AuditResults({
  data, pageIndex, onPrevious, onNext,
}: {
  data: AuditViewData
  pageIndex: number
  onPrevious: () => void
  onNext: () => void
}) {
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-zinc-600">窗口 {timestamp(data.filters.since)} — {timestamp(data.filters.until)}</p>
      <div className="flex gap-2">
        <a href={adminApi.auditExportUrl(data.filters, 'csv')} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.05]">下载 CSV</a>
        <a href={adminApi.auditExportUrl(data.filters, 'json')} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.05]">下载 JSON</a>
      </div>
    </div>
    <SummaryStrip summary={data.summary} />
    <RecordList rows={data.page.rows} />
    <Pagination data={data} pageIndex={pageIndex}
      onPrevious={onPrevious} onNext={onNext} />
    <Reconciliation data={data.reconciliation} />
    <CutoverEvents data={data.cutovers} />
  </>
}

export function AuditPanel() {
  const [filters, setFilters] = useState(() => filtersFromHash(window.location.hash))
  const [draft, setDraft] = useState(filters)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const resource = useAuditResource(filters, cursors[pageIndex])
  const data = resource.state.data

  useEffect(() => {
    if (!data || filters.snapshot_max_id != null) return
    setFilters(data.filters)
    setDraft(current => ({ ...current, snapshot_max_id: data.filters.snapshot_max_id }))
  }, [data?.filters.snapshot_max_id, filters.snapshot_max_id])

  const apply = () => {
    setFilters(draft)
    setCursors([null])
    setPageIndex(0)
  }
  const refreshSnapshot = () => {
    const now = new Date()
    const next = { ...draft, until: now.toISOString(), snapshot_max_id: undefined }
    setDraft(next); setFilters(next); setCursors([null]); setPageIndex(0)
  }
  const nextPage = () => {
    if (!data?.page.next_cursor) return
    setCursors(current => [...current.slice(0, pageIndex + 1), data.page.next_cursor])
    setPageIndex(index => index + 1)
  }
  return <div className="space-y-5">
    <AuditHeader data={data} />
    <AuditFiltersForm value={draft} onChange={setDraft} onApply={apply} onRefreshSnapshot={refreshSnapshot} />
    <ReadFeedback loading={resource.state.status === 'loading' || resource.state.status === 'refreshing'}
      hasData={data != null} error={resource.state.error}
      label="加载审计快照…" onRetry={resource.load} />
    {data ? <AuditResults data={data} pageIndex={pageIndex}
      onPrevious={() => setPageIndex(index => index - 1)} onNext={nextPage} /> : null}
  </div>
}
