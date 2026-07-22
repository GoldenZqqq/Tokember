export type AlertRuleKind = 'budget' | 'spike' | 'source_health' | 'unpriced_growth'
export type AlertMetric = 'cost' | 'tokens'
export type AlertPeriod = 'day' | 'month'
export type AlertEvaluationStatus = 'ok' | 'triggered' | 'insufficient_data' | 'error'
export type AlertEventStatus = 'active' | 'recovered'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertNotificationStatus =
  | 'not_requested'
  | 'not_configured'
  | 'cooldown'
  | 'pending'
  | 'delivered'
  | 'failed'

export interface BudgetAlertConfig {
  period: AlertPeriod
  metric: AlertMetric
  limit: number
}

export interface SpikeAlertConfig {
  metric: AlertMetric
  multiplier: number
  baseline_days: number
  minimum_value: number
}

export interface SourceHealthAlertConfig {
  consecutive_failures: number
  stale_minutes: number
}

export interface UnpricedGrowthAlertConfig {
  baseline_days: number
  increase_ratio: number
  minimum_current_ratio: number
}

export type AlertRuleConfig =
  | BudgetAlertConfig
  | SpikeAlertConfig
  | SourceHealthAlertConfig
  | UnpricedGrowthAlertConfig

interface AlertRuleInputBase {
  name: string
  device_id: string | null
  provider: string | null
  timezone: string
  enabled: boolean
  cooldown_minutes: number
  notify_webhook: boolean
}

export type AlertRuleInput = AlertRuleInputBase & (
  | { kind: 'budget'; config: BudgetAlertConfig }
  | { kind: 'spike'; config: SpikeAlertConfig }
  | { kind: 'source_health'; config: SourceHealthAlertConfig }
  | { kind: 'unpriced_growth'; config: UnpricedGrowthAlertConfig }
)

export type AlertRule = AlertRuleInput & {
  id: number
  created_at: string
  updated_at: string
}

export interface AlertEvidenceWindow {
  since: string
  until: string
}

export interface BudgetAlertEvidence {
  kind: 'budget'
  metric: AlertMetric
  period: AlertPeriod
  window: AlertEvidenceWindow
  used: number
  limit: number
  ratio: number
  forecast: number
  forecast_incomplete: boolean
  threshold: number | null
}

export interface SpikeAlertEvidence {
  kind: 'spike'
  metric: AlertMetric
  window: AlertEvidenceWindow
  baseline_window: AlertEvidenceWindow
  current: number
  forecast: number
  baseline: number
  multiplier: number
  sample_days: number
  forecast_incomplete: boolean
}

export interface SourceHealthAlertEvidence {
  kind: 'source_health'
  device_id: string
  source: string | null
  state: 'never' | 'failed' | 'stale'
  last_run_at: string | null
  consecutive_failures: number
  stale_minutes: number
}

export interface UnpricedGrowthAlertEvidence {
  kind: 'unpriced_growth'
  window: AlertEvidenceWindow
  baseline_window: AlertEvidenceWindow
  current_ratio: number
  baseline_ratio: number
  increase_ratio: number
  sample_days: number
  unpriced_tokens: number
  total_tokens: number
}

export type AlertEvidence =
  | BudgetAlertEvidence
  | SpikeAlertEvidence
  | SourceHealthAlertEvidence
  | UnpricedGrowthAlertEvidence

export interface AlertRuleEvaluation {
  rule_id: number
  evaluated_at: string
  status: AlertEvaluationStatus
  reason: string
  evidence: AlertEvidence | null
}

export type AlertRuleWithEvaluation = AlertRule & {
  evaluation: AlertRuleEvaluation | null
}

export interface AlertEvent {
  id: number
  rule_id: number
  rule_name: string
  kind: AlertRuleKind
  device_id: string | null
  provider: string | null
  dedup_key: string
  status: AlertEventStatus
  severity: AlertSeverity
  first_triggered_at: string
  last_triggered_at: string
  recovered_at: string | null
  acknowledged_at: string | null
  cooldown_until: string
  notification_status: AlertNotificationStatus
  evidence: AlertEvidence
}

export interface AlertCenterResponse {
  webhook_configured: boolean
  rules: AlertRuleWithEvaluation[]
  events: AlertEvent[]
}

export interface AlertRuleResponse {
  rule: AlertRuleWithEvaluation
}

export interface AlertEvaluationResponse extends AlertCenterResponse {
  evaluated_at: string
}
