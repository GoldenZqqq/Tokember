import { useEffect, useState } from 'react'
import { adminApi, type PricingMode, type PricingRule, type PricingRuleInput, type RepriceResult } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { useT, type TranslateFn } from '../../i18n'
import { providerDisplayName } from '../../provider-display'
import { ReadFeedback } from '../ReadFeedback'

const EMPTY_RULE: PricingRuleInput = {
  source: null, model: '', mode: 'priced', input_price: 0,
  output_price: 0, cache_read_price: 0, cache_write_price: 0, enabled: 1,
}

const MODE_STYLES: Record<PricingMode, string> = {
  priced: 'bg-white/[0.06] text-zinc-300',
  free: 'bg-emerald-500/10 text-emerald-300',
  included: 'bg-blue-500/10 text-blue-300',
}

function modeLabel(mode: PricingMode, t: TranslateFn): string {
  if (mode === 'priced') return t('pricingStatus.priced')
  if (mode === 'free') return t('pricingStatus.free')
  return t('pricingStatus.included')
}

function priceSummary(rule: PricingRule, t: TranslateFn): string {
  if (rule.mode !== 'priced') return modeLabel(rule.mode, t)
  return t('pricingUi.priceInOut', { input: rule.input_price, output: rule.output_price })
}

/** Shows whether a catalog rule still tracks upstream prices or has been edited. */
function OriginBadge({ rule, t }: { rule: PricingRule; t: TranslateFn }) {
  if (rule.origin !== 'builtin') return null
  const edited = rule.user_modified === 1
  return (
    <span
      title={t(edited ? 'pricingUi.customizedHint' : 'pricingUi.builtinHint')}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
        edited ? 'text-amber-300 ring-amber-500/25' : 'text-zinc-400 ring-white/10'
      }`}
    >
      {t(edited ? 'pricingUi.customized' : 'pricingUi.builtin')}
    </span>
  )
}

export function PricingRulesPanel() {
  const t = useT()
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
    setMessage(reason instanceof Error ? reason.message : t('common.operationsFailed'))
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
      setMessage(t('settingsUi.ruleSaved'))
    } catch (reason) { showError(reason) }
  }

  async function deleteRule(id: number) {
    if (!window.confirm(t('settingsUi.confirmDeleteRule'))) return
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
      setMessage(t('settingsUi.aliasMapped', {
        source, alias, model: result.model, n: result.repriced,
      }))
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
      setMessage(t('settingsUi.aliasRemoved'))
    } catch (reason) { showError(reason) }
  }

  async function reprice(apply: boolean) {
    try {
      const result = await adminApi.reprice(apply)
      setPreview(result)
      setMessage(apply ? t('settingsUi.repricedRecords', { n: result.matched }) : '')
    } catch (reason) { showError(reason) }
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-400">Pricing Engine</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">{t('pricingUi.title')}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">{t('pricingUi.subtitle')}</p>
      </header>

      <section className="space-y-3">
        <ReadFeedback
          loading={loading} hasData={rules.length > 0} error={loadError}
          label={t('pricingUi.loading')} onRetry={() => { loadRules() }}
        />
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-300">
            {t('pricingUi.configured')} <span className="ml-1 text-zinc-600">{rules.length}</span>
          </h3>
          <button
            onClick={() => { setAdding(v => !v); setMessage('') }}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              adding
                ? 'border border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.07]'
                : 'bg-orange-500 text-zinc-950 hover:bg-orange-400'
            }`}
          >
            {adding ? t('pricingUi.cancel') : t('pricingUi.addRule')}
          </button>
        </div>

        {adding && (
          <section className="rounded-2xl border border-orange-500/20 bg-orange-500/[0.04] p-4 md:p-5">
            <h4 className="text-sm font-semibold text-zinc-200">{t('pricingUi.newRule')}</h4>
            <RuleFields value={draft} onChange={setDraft} />
            <div className="mt-4 flex justify-end">
              <button onClick={createRule} disabled={!draft.model} className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-orange-400 disabled:opacity-40">{t('pricingUi.addPricingRule')}</button>
            </div>
          </section>
        )}

        {!loading && !loadError && rules.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-600">{t('pricingUi.empty')}</div>
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
          <h3 className="text-sm font-semibold text-zinc-200">{t('pricingUi.historicalUnpriced')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('pricingUi.historicalHint')}</p>
          {preview && <p className="mt-3 text-sm text-blue-300">{t('pricingUi.coverPreview', {
            n: preview.matched.toLocaleString(), delta: preview.cost_delta.toFixed(6),
          })}</p>}
        </div>
        <div className="mt-4 flex shrink-0 gap-2 md:mt-0">
          <button onClick={() => reprice(false)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07]">{t('pricingUi.previewReprice')}</button>
          <button onClick={() => reprice(true)} disabled={!preview || preview.matched === 0} className="rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">{t('pricingUi.applyReprice')}</button>
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
  const t = useT()
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
              {rule.model || t('pricingUi.unnamedModel')}
            </span>
            {!rule.enabled && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 ring-1 ring-white/10">{t('pricingUi.disabled')}</span>}
            <OriginBadge rule={rule} t={t} />
          </div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {rule.source ? t('pricingUi.sourceOverride', { source: providerDisplayName(rule.source) }) : t('pricingUi.globalOfficial')}
            {rule.aliases.length > 0 ? t('pricingUi.aliasesCount', { n: rule.aliases.length }) : ''}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${MODE_STYLES[rule.mode]}`}>
          {modeLabel(rule.mode, t)}
        </span>
        <span className="hidden shrink-0 text-xs tabular-nums text-zinc-400 lg:block">{priceSummary(rule, t)}</span>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-1">
          <RuleFields value={value} onChange={setValue} />
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-zinc-500">{t('pricingUi.modelAliases')}</span>
              {rule.aliases.length === 0 ? (
                <span className="text-xs text-zinc-600">{t('pricingUi.noneYet')}</span>
              ) : rule.aliases.map(alias => (
                <span key={alias.id} className="inline-flex max-w-full items-center gap-1 rounded bg-white/[0.05] px-2 py-1 text-xs text-zinc-300">
                  <span className="truncate">{providerDisplayName(alias.source)} / {alias.alias}</span>
                  <button
                    type="button"
                    title={t('pricingUi.deleteAlias')}
                    aria-label={t('pricingUi.deleteAliasAria', { alias: alias.alias })}
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
                placeholder={t('pricingUi.sourcePlaceholder')}
                disabled={rule.source != null}
              />
              <input
                value={aliasName}
                onChange={event => setAliasName(event.target.value)}
                className="field-input"
                placeholder={t('pricingUi.unknownModel')}
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
              >{t('pricingUi.addAlias')}</button>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => onDelete(rule.id)} className="rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-500/10">{t('pricingUi.delete')}</button>
            <button onClick={() => onSave({ id: rule.id, ...value })} className="rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-300 hover:bg-orange-500/15">{t('pricingUi.saveChanges')}</button>
          </div>
        </div>
      )}
    </article>
  )
}

function RuleFields({ value, onChange }: { value: PricingRuleInput; onChange: (value: PricingRuleInput) => void }) {
  const t = useT()
  const set = <K extends keyof PricingRuleInput>(key: K, next: PricingRuleInput[K]) => onChange({ ...value, [key]: next })
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Field label={t('pricingUi.sourceOverrideOptional')}><input value={value.source ?? ''} onChange={e => set('source', e.target.value || null)} className="field-input" placeholder={t('pricingUi.leaveEmptyGlobal')} /></Field>
      <Field label={t('pricingUi.model')}><input value={value.model} onChange={e => set('model', e.target.value)} className="field-input" placeholder="mimo-v2.5-pro" /></Field>
      <Field label={t('pricingUi.pricingMode')}><select value={value.mode} onChange={e => set('mode', e.target.value as PricingMode)} className="field-input">
        <option value="priced">{t('pricingStatus.priced')}</option>
        <option value="free">{t('pricingStatus.free')}</option>
        <option value="included">{t('pricingStatus.included')}</option>
      </select></Field>
      <Field label={t('pricingUi.status')}><select value={value.enabled} onChange={e => set('enabled', Number(e.target.value))} className="field-input">
        <option value={1}>{t('pricingUi.enabled')}</option>
        <option value={0}>{t('pricingUi.disabledOption')}</option>
      </select></Field>
      <PriceField label={t('pricingUi.input')} value={value.input_price} onChange={v => set('input_price', v)} />
      <PriceField label={t('pricingUi.output')} value={value.output_price} onChange={v => set('output_price', v)} />
      <PriceField label={t('pricingUi.cacheRead')} value={value.cache_read_price} onChange={v => set('cache_read_price', v)} />
      <PriceField label={t('pricingUi.cacheWrite')} value={value.cache_write_price} onChange={v => set('cache_write_price', v)} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] font-medium text-zinc-500"><span className="mb-1.5 block">{label}</span>{children}</label>
}

function PriceField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <Field label={`${label} $/1M`}><input type="number" min="0" step="0.000001" value={value} onChange={e => onChange(Number(e.target.value))} className="field-input tabular-nums" /></Field>
}
