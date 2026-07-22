import { useEffect, useState } from 'react'
import { adminApi, type PricingMode, type PricingRule, type PricingRuleInput, type RepriceResult } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { providerDisplayName } from '../../provider-display'
import { ReadFeedback } from '../ReadFeedback'

const EMPTY_RULE: PricingRuleInput = {
  source: null, model: '', mode: 'priced', input_price: 0,
  output_price: 0, cache_read_price: 0, cache_write_price: 0, enabled: 1,
}

const MODE_LABELS: Record<PricingMode, string> = {
  priced: '按量计价', free: '免费', included: '套餐包含',
}

const MODE_STYLES: Record<PricingMode, string> = {
  priced: 'bg-white/[0.06] text-zinc-300',
  free: 'bg-emerald-500/10 text-emerald-300',
  included: 'bg-blue-500/10 text-blue-300',
}

function priceSummary(rule: PricingRule): string {
  if (rule.mode !== 'priced') return MODE_LABELS[rule.mode]
  return `输入 $${rule.input_price} · 输出 $${rule.output_price} / 1M`
}

export function PricingRulesPanel() {
  const [rules, setRules] = useState<PricingRule[]>([])
  const [draft, setDraft] = useState<PricingRuleInput>(EMPTY_RULE)
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [preview, setPreview] = useState<RepriceResult | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ApiError | null>(null)

  async function loadRules() {
    setLoading(true)
    setLoadError(null)
    try {
      setRules((await adminApi.rules()).rules)
    } catch (reason) {
      setLoadError(toApiError(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRules() }, [])

  function showError(reason: unknown) {
    setMessage(reason instanceof Error ? reason.message : '操作失败')
  }

  async function createRule() {
    setMessage('')
    try {
      await adminApi.createRule(draft)
      setDraft(EMPTY_RULE)
      setAdding(false)
      await loadRules()
      setPreview(null)
    } catch (reason) { showError(reason) }
  }

  async function saveRule(rule: PricingRuleInput & { id: number }) {
    try {
      await adminApi.updateRule(rule.id, rule)
      await loadRules()
      setExpandedId(null)
      setPreview(null)
      setMessage('规则已保存')
    } catch (reason) { showError(reason) }
  }

  async function deleteRule(id: number) {
    if (!window.confirm('确认删除这条计价规则？')) return
    try {
      await adminApi.deleteRule(id)
      await loadRules()
      setPreview(null)
    } catch (reason) { showError(reason) }
  }

  async function addAlias(ruleId: number, source: string, alias: string) {
    try {
      const result = await adminApi.addAlias(ruleId, source, alias)
      await loadRules()
      setMessage(`已将 ${source} / ${alias} 归入 ${result.model}，补价 ${result.repriced} 条`)
      return true
    } catch (reason) {
      showError(reason)
      return false
    }
  }

  async function deleteAlias(id: number) {
    try {
      await adminApi.deleteAlias(id)
      await loadRules()
      setMessage('别名已移除；已归类的历史记录保持标准模型名')
    } catch (reason) { showError(reason) }
  }

  async function reprice(apply: boolean) {
    try {
      const result = await adminApi.reprice(apply)
      setPreview(result)
      setMessage(apply ? `已补价 ${result.matched} 条记录` : '')
    } catch (reason) { showError(reason) }
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-400">Pricing Engine</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">模型计价规则</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">默认按模型匹配官方价格；仅在某个接入来源价格不同时添加来源覆盖。单价单位均为 USD / 1M Tokens。</p>
      </header>

      <section className="space-y-3">
        <ReadFeedback
          loading={loading} hasData={rules.length > 0} error={loadError}
          label="加载规则中…" onRetry={() => { loadRules() }}
        />
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-300">
            已配置规则 <span className="ml-1 text-zinc-600">{rules.length}</span>
          </h3>
          <button
            onClick={() => { setAdding(v => !v); setMessage('') }}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              adding
                ? 'border border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.07]'
                : 'bg-orange-500 text-zinc-950 hover:bg-orange-400'
            }`}
          >
            {adding ? '取消' : '+ 添加规则'}
          </button>
        </div>

        {adding && (
          <section className="rounded-2xl border border-orange-500/20 bg-orange-500/[0.04] p-4 md:p-5">
            <h4 className="text-sm font-semibold text-zinc-200">新计价规则</h4>
            <RuleFields value={draft} onChange={setDraft} />
            <div className="mt-4 flex justify-end">
              <button onClick={createRule} disabled={!draft.model} className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-orange-400 disabled:opacity-40">添加计价规则</button>
            </div>
          </section>
        )}

        {!loading && !loadError && rules.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-600">暂无计价规则，点击右上角添加。</div>
        ) : rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map(rule => (
              <RuleRow
                key={rule.id}
                rule={rule}
                expanded={expandedId === rule.id}
                onToggle={() => setExpandedId(id => (id === rule.id ? null : rule.id))}
                onSave={saveRule}
                onDelete={deleteRule}
                onAddAlias={addAlias}
                onDeleteAlias={deleteAlias}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-blue-500/10 bg-blue-500/[0.035] p-4 md:flex md:items-center md:justify-between md:gap-6 md:p-5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">历史未计价数据</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">先预览当前规则能够覆盖的记录，再确认应用，不会覆盖已有成本。</p>
          {preview && <p className="mt-3 text-sm text-blue-300">可覆盖 {preview.matched.toLocaleString()} 条，新增成本 ${preview.cost_delta.toFixed(6)}</p>}
        </div>
        <div className="mt-4 flex shrink-0 gap-2 md:mt-0">
          <button onClick={() => reprice(false)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07]">预览补价</button>
          <button onClick={() => reprice(true)} disabled={!preview || preview.matched === 0} className="rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">应用补价</button>
        </div>
      </section>
      {message && <p className="text-sm text-zinc-400">{message}</p>}
    </div>
  )
}

function RuleRow({
  rule, expanded, onToggle, onSave, onDelete, onAddAlias, onDeleteAlias,
}: {
  rule: PricingRule
  expanded: boolean
  onToggle: () => void
  onSave: (rule: PricingRuleInput & { id: number }) => void
  onDelete: (id: number) => void
  onAddAlias: (ruleId: number, source: string, alias: string) => Promise<boolean>
  onDeleteAlias: (id: number) => void
}) {
  const [value, setValue] = useState<PricingRuleInput>(rule)
  const [aliasSource, setAliasSource] = useState(rule.source ?? '')
  const [aliasName, setAliasName] = useState('')
  useEffect(() => {
    setValue(rule)
    setAliasSource(rule.source ?? '')
  }, [rule])

  return (
    <article className={`overflow-hidden rounded-xl border transition ${
      expanded ? 'border-orange-500/25 bg-white/[0.03]' : 'border-white/[0.06] bg-white/[0.02] hover:border-white/10'
    }`}>
      <button onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate text-sm font-semibold ${rule.enabled ? 'text-zinc-100' : 'text-zinc-500'}`}>
              {rule.model || '未命名模型'}
            </span>
            {!rule.enabled && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 ring-1 ring-white/10">停用</span>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {rule.source ? `来源覆盖 · ${providerDisplayName(rule.source)}` : '全局官方价格'}
            {rule.aliases.length > 0 ? ` · ${rule.aliases.length} 个别名` : ''}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${MODE_STYLES[rule.mode]}`}>
          {MODE_LABELS[rule.mode]}
        </span>
        <span className="hidden shrink-0 text-xs tabular-nums text-zinc-400 lg:block">{priceSummary(rule)}</span>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-1">
          <RuleFields value={value} onChange={setValue} />
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-zinc-500">模型别名</span>
              {rule.aliases.length === 0 ? (
                <span className="text-xs text-zinc-600">暂无</span>
              ) : rule.aliases.map(alias => (
                <span key={alias.id} className="inline-flex max-w-full items-center gap-1 rounded bg-white/[0.05] px-2 py-1 text-xs text-zinc-300">
                  <span className="truncate">{providerDisplayName(alias.source)} / {alias.alias}</span>
                  <button
                    type="button"
                    title="删除别名"
                    aria-label={`删除别名 ${alias.alias}`}
                    onClick={() => onDeleteAlias(alias.id)}
                    className="shrink-0 px-1 text-zinc-500 hover:text-red-400"
                  >×</button>
                </span>
              ))}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto]">
              <input
                value={aliasSource}
                onChange={event => setAliasSource(event.target.value)}
                className="field-input"
                placeholder="来源，例如 claude"
                disabled={rule.source != null}
              />
              <input
                value={aliasName}
                onChange={event => setAliasName(event.target.value)}
                className="field-input"
                placeholder="未识别的模型名称"
              />
              <button
                type="button"
                disabled={!aliasSource.trim() || !aliasName.trim()}
                onClick={async () => {
                  const added = await onAddAlias(
                    rule.id, aliasSource.trim(), aliasName.trim(),
                  )
                  if (added) setAliasName('')
                }}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] disabled:opacity-40"
              >添加别名</button>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => onDelete(rule.id)} className="rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-500/10">删除</button>
            <button onClick={() => onSave({ id: rule.id, ...value })} className="rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-300 hover:bg-orange-500/15">保存修改</button>
          </div>
        </div>
      )}
    </article>
  )
}

function RuleFields({ value, onChange }: { value: PricingRuleInput; onChange: (value: PricingRuleInput) => void }) {
  const set = <K extends keyof PricingRuleInput>(key: K, next: PricingRuleInput[K]) => onChange({ ...value, [key]: next })
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Field label="来源覆盖（可选）"><input value={value.source ?? ''} onChange={e => set('source', e.target.value || null)} className="field-input" placeholder="留空 = 全局规则" /></Field>
      <Field label="模型"><input value={value.model} onChange={e => set('model', e.target.value)} className="field-input" placeholder="mimo-v2.5-pro" /></Field>
      <Field label="计价模式"><select value={value.mode} onChange={e => set('mode', e.target.value as PricingMode)} className="field-input"><option value="priced">按量计价</option><option value="free">免费</option><option value="included">套餐包含</option></select></Field>
      <Field label="状态"><select value={value.enabled} onChange={e => set('enabled', Number(e.target.value))} className="field-input"><option value={1}>启用</option><option value={0}>停用</option></select></Field>
      <PriceField label="输入" value={value.input_price} onChange={v => set('input_price', v)} />
      <PriceField label="输出" value={value.output_price} onChange={v => set('output_price', v)} />
      <PriceField label="缓存读取" value={value.cache_read_price} onChange={v => set('cache_read_price', v)} />
      <PriceField label="缓存写入" value={value.cache_write_price} onChange={v => set('cache_write_price', v)} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] font-medium text-zinc-500"><span className="mb-1.5 block">{label}</span>{children}</label>
}

function PriceField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <Field label={`${label} $/1M`}><input type="number" min="0" step="0.000001" value={value} onChange={e => onChange(Number(e.target.value))} className="field-input tabular-nums" /></Field>
}
