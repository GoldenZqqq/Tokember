import type {
  AlertRule,
  AlertRuleConfig,
  AlertRuleInput,
  AlertRuleKind,
  BudgetAlertConfig,
  SourceHealthAlertConfig,
  SpikeAlertConfig,
  UnpricedGrowthAlertConfig,
} from '@tokember/contracts/alerts'
import { useT, type TranslateFn } from '../../i18n'

interface DeviceChoice {
  id: string
  name: string
}

function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function defaultConfig(kind: AlertRuleKind): AlertRuleConfig {
  if (kind === 'budget') return { period: 'day', metric: 'cost', limit: 10 }
  if (kind === 'spike') {
    return { metric: 'tokens', multiplier: 2, baseline_days: 7, minimum_value: 0 }
  }
  if (kind === 'source_health') return { consecutive_failures: 2, stale_minutes: 120 }
  return { baseline_days: 7, increase_ratio: 0.1, minimum_current_ratio: 0.2 }
}

export function defaultAlertRuleInput(kind: AlertRuleKind = 'budget'): AlertRuleInput {
  return {
    name: '', kind, device_id: null, provider: null,
    timezone: runtimeTimeZone(), enabled: true, cooldown_minutes: 60,
    notify_webhook: false, config: defaultConfig(kind),
  } as AlertRuleInput
}

export function editableAlertRule(rule: AlertRule): AlertRuleInput {
  const { id: _id, created_at: _created, updated_at: _updated, ...input } = rule
  return input
}

function BudgetFields({
  value, onChange, t,
}: { value: BudgetAlertConfig; onChange: (value: BudgetAlertConfig) => void; t: TranslateFn }) {
  return <>
    <SelectField label={t('settingsUi.period')} value={value.period}
      onChange={period => onChange({ ...value, period: period as 'day' | 'month' })}
      options={[['day', t('settingsUi.daily')], ['month', t('settingsUi.monthly')]]} />
    <SelectField label={t('settingsUi.metric')} value={value.metric}
      onChange={metric => onChange({ ...value, metric: metric as 'cost' | 'tokens' })}
      options={[['cost', t('settingsUi.usdCost')], ['tokens', t('settingsUi.realTokens')]]} />
    <NumberField label={t('settingsUi.budgetLimit')} value={value.limit} min={0.000001}
      onChange={limit => onChange({ ...value, limit })} />
  </>
}

function SpikeFields({
  value, onChange, t,
}: { value: SpikeAlertConfig; onChange: (value: SpikeAlertConfig) => void; t: TranslateFn }) {
  return <>
    <SelectField label={t('settingsUi.metric')} value={value.metric}
      onChange={metric => onChange({ ...value, metric: metric as 'cost' | 'tokens' })}
      options={[['cost', t('settingsUi.usdCost')], ['tokens', t('settingsUi.realTokens')]]} />
    <NumberField label={t('settingsUi.spikeMultiplier')} value={value.multiplier} min={1.01} step={0.1}
      onChange={multiplier => onChange({ ...value, multiplier })} />
    <NumberField label={t('settingsUi.baselineDays')} value={value.baseline_days} min={3} max={30}
      onChange={baseline_days => onChange({ ...value, baseline_days })} />
    <NumberField label={t('settingsUi.minimumForecast')} value={value.minimum_value} min={0}
      onChange={minimum_value => onChange({ ...value, minimum_value })} />
  </>
}

function SourceFields({
  value, onChange, t,
}: { value: SourceHealthAlertConfig; onChange: (value: SourceHealthAlertConfig) => void; t: TranslateFn }) {
  return <>
    <NumberField label={t('settingsUi.consecutiveFailures')} value={value.consecutive_failures} min={1} max={100}
      onChange={consecutive_failures => onChange({ ...value, consecutive_failures })} />
    <NumberField label={t('settingsUi.staleMinutes')} value={value.stale_minutes} min={1} max={10080}
      onChange={stale_minutes => onChange({ ...value, stale_minutes })} />
  </>
}

function UnpricedFields({
  value, onChange, t,
}: { value: UnpricedGrowthAlertConfig; onChange: (value: UnpricedGrowthAlertConfig) => void; t: TranslateFn }) {
  return <>
    <NumberField label={t('settingsUi.baselineDays')} value={value.baseline_days} min={3} max={30}
      onChange={baseline_days => onChange({ ...value, baseline_days })} />
    <NumberField label={t('settingsUi.increaseRatio')} value={value.increase_ratio} min={0} max={1} step={0.01}
      onChange={increase_ratio => onChange({ ...value, increase_ratio })} />
    <NumberField label={t('settingsUi.minCurrentRatio')} value={value.minimum_current_ratio}
      min={0} max={1} step={0.01}
      onChange={minimum_current_ratio => onChange({ ...value, minimum_current_ratio })} />
  </>
}

function KindFields({ value, onChange, t }: {
  value: AlertRuleInput
  onChange: (config: AlertRuleConfig) => void
  t: TranslateFn
}) {
  if (value.kind === 'budget') return <BudgetFields value={value.config} onChange={onChange} t={t} />
  if (value.kind === 'spike') return <SpikeFields value={value.config} onChange={onChange} t={t} />
  if (value.kind === 'source_health') {
    return <SourceFields value={value.config} onChange={onChange} t={t} />
  }
  return <UnpricedFields value={value.config} onChange={onChange} t={t} />
}

function SelectField({ label, value, options, onChange }: {
  label: string
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
}) {
  return <label className="text-xs text-zinc-500"><span className="mb-1.5 block">{label}</span>
    <select className="field-input" value={value}
      onChange={event => onChange(event.target.value)}>
      {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
    </select>
  </label>
}

function NumberField({ label, value, onChange, min, max, step = 1 }: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return <label className="text-xs text-zinc-500"><span className="mb-1.5 block">{label}</span>
    <input className="field-input" type="number" value={value} min={min} max={max} step={step}
      onChange={event => onChange(Number(event.target.value))} />
  </label>
}

function CommonFields({ value, devices, onChange, t }: {
  value: AlertRuleInput
  devices: DeviceChoice[]
  onChange: (value: AlertRuleInput) => void
  t: TranslateFn
}) {
  const kinds: Array<[AlertRuleKind, string]> = [
    ['budget', t('alerts.budget')],
    ['spike', t('alerts.spike')],
    ['source_health', t('settingsUi.sourceFailStale')],
    ['unpriced_growth', t('settingsUi.unpricedShareGrowth')],
  ]
  return <>
    <label className="text-xs text-zinc-500"><span className="mb-1.5 block">{t('settingsUi.ruleName')}</span>
      <input className="field-input" value={value.name} maxLength={120}
        onChange={event => onChange({ ...value, name: event.target.value })} />
    </label>
    <SelectField label={t('settingsUi.ruleKind')} value={value.kind}
      onChange={kind => onChange({
        ...value, kind, config: defaultConfig(kind as AlertRuleKind),
      } as AlertRuleInput)}
      options={kinds} />
    <SelectField label={t('settingsUi.deviceScope')} value={value.device_id ?? ''}
      onChange={device_id => onChange({ ...value, device_id: device_id || null })}
      options={[['', t('settingsUi.allDevices')], ...devices.map(device => [device.id, device.name] as [string, string])]} />
    <label className="text-xs text-zinc-500"><span className="mb-1.5 block">{t('settingsUi.providerOptional')}</span>
      <input className="field-input" value={value.provider ?? ''} maxLength={80}
        placeholder={t('settingsUi.providerPlaceholder')}
        onChange={event => onChange({ ...value, provider: event.target.value || null })} />
    </label>
    <label className="text-xs text-zinc-500"><span className="mb-1.5 block">{t('settingsUi.timezone')}</span>
      <input className="field-input" value={value.timezone} maxLength={120}
        onChange={event => onChange({ ...value, timezone: event.target.value })} />
    </label>
    <NumberField label={t('settingsUi.cooldownMinutes')} value={value.cooldown_minutes} min={0} max={10080}
      onChange={cooldown_minutes => onChange({ ...value, cooldown_minutes })} />
  </>
}

export function AlertRuleForm({
  value, devices, editing, saving, onChange, onSubmit, onCancel,
}: {
  value: AlertRuleInput
  devices: DeviceChoice[]
  editing: boolean
  saving: boolean
  onChange: (value: AlertRuleInput) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const t = useT()
  return <form className="space-y-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
    onSubmit={event => { event.preventDefault(); onSubmit() }}>
    <div><h3 className="text-sm font-semibold text-zinc-200">{editing ? t('settingsUi.editRule') : t('settingsUi.newRule')}</h3>
      <p className="mt-1 text-xs text-zinc-600">{t('settingsUi.formHint')}</p></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <CommonFields value={value} devices={devices} onChange={onChange} t={t} />
      <KindFields value={value} onChange={config => onChange({ ...value, config } as AlertRuleInput)} t={t} />
    </div>
    <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
      <label className="flex items-center gap-2"><input type="checkbox" checked={value.enabled}
        onChange={event => onChange({ ...value, enabled: event.target.checked })} />{t('settingsUi.enableRule')}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={value.notify_webhook}
        onChange={event => onChange({ ...value, notify_webhook: event.target.checked })} />{t('settingsUi.sendWebhook')}</label>
    </div>
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onCancel}
        className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/[0.05]">{t('common.cancel')}</button>
      <button type="submit" disabled={saving}
        className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-black hover:bg-orange-400 disabled:opacity-50">
        {saving ? t('settingsUi.saving') : editing ? t('settingsUi.saveChanges') : t('settingsUi.createRule')}
      </button>
    </div>
  </form>
}
