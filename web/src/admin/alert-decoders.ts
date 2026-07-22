import type {
  AlertCenterResponse,
  AlertEvaluationResponse,
  AlertEvidence,
  AlertEvent,
  AlertRule,
  AlertRuleConfig,
  AlertRuleEvaluation,
  AlertRuleKind,
  AlertRuleResponse,
  AlertRuleWithEvaluation,
} from '@tokember/contracts/alerts'
import {
  arrayValue, booleanValue, literalValue, nullableString,
  numberValue, objectValue, stringValue,
} from '../data/decoders'

const KINDS = ['budget', 'spike', 'source_health', 'unpriced_growth'] as const
const METRICS = ['cost', 'tokens'] as const
const PERIODS = ['day', 'month'] as const
const EVALUATION_STATUSES = ['ok', 'triggered', 'insufficient_data', 'error'] as const
const EVENT_STATUSES = ['active', 'recovered'] as const
const SEVERITIES = ['info', 'warning', 'critical'] as const
const NOTIFICATION_STATUSES = [
  'not_requested', 'not_configured', 'cooldown', 'pending', 'delivered', 'failed',
] as const

function windowValue(value: unknown) {
  const row = objectValue(value, 'alert window')
  return { since: stringValue(row.since), until: stringValue(row.until) }
}

function ruleConfig(kind: AlertRuleKind, value: unknown): AlertRuleConfig {
  const row = objectValue(value, 'alert rule config')
  if (kind === 'budget') return {
    period: literalValue(row.period, PERIODS), metric: literalValue(row.metric, METRICS),
    limit: numberValue(row.limit),
  }
  if (kind === 'spike') return {
    metric: literalValue(row.metric, METRICS), multiplier: numberValue(row.multiplier),
    baseline_days: numberValue(row.baseline_days), minimum_value: numberValue(row.minimum_value),
  }
  if (kind === 'source_health') return {
    consecutive_failures: numberValue(row.consecutive_failures),
    stale_minutes: numberValue(row.stale_minutes),
  }
  return {
    baseline_days: numberValue(row.baseline_days),
    increase_ratio: numberValue(row.increase_ratio),
    minimum_current_ratio: numberValue(row.minimum_current_ratio),
  }
}

function ruleValue(value: unknown): AlertRule {
  const row = objectValue(value, 'alert rule')
  const kind = literalValue(row.kind, KINDS)
  return {
    id: numberValue(row.id), name: stringValue(row.name), kind,
    device_id: nullableString(row.device_id), provider: nullableString(row.provider),
    timezone: stringValue(row.timezone), config: ruleConfig(kind, row.config),
    enabled: booleanValue(row.enabled), cooldown_minutes: numberValue(row.cooldown_minutes),
    notify_webhook: booleanValue(row.notify_webhook),
    created_at: stringValue(row.created_at), updated_at: stringValue(row.updated_at),
  } as AlertRule
}

function budgetEvidence(row: Record<string, unknown>): AlertEvidence {
  return {
    kind: 'budget', metric: literalValue(row.metric, METRICS),
    period: literalValue(row.period, PERIODS), window: windowValue(row.window),
    used: numberValue(row.used), limit: numberValue(row.limit), ratio: numberValue(row.ratio),
    forecast: numberValue(row.forecast),
    forecast_incomplete: booleanValue(row.forecast_incomplete),
    threshold: row.threshold === null ? null : numberValue(row.threshold),
  }
}

function spikeEvidence(row: Record<string, unknown>): AlertEvidence {
  return {
    kind: 'spike', metric: literalValue(row.metric, METRICS),
    window: windowValue(row.window), baseline_window: windowValue(row.baseline_window),
    current: numberValue(row.current), forecast: numberValue(row.forecast),
    baseline: numberValue(row.baseline), multiplier: numberValue(row.multiplier),
    sample_days: numberValue(row.sample_days),
    forecast_incomplete: booleanValue(row.forecast_incomplete),
  }
}

function sourceEvidence(row: Record<string, unknown>): AlertEvidence {
  return {
    kind: 'source_health', device_id: stringValue(row.device_id),
    source: nullableString(row.source),
    state: literalValue(row.state, ['never', 'failed', 'stale'] as const),
    last_run_at: nullableString(row.last_run_at),
    consecutive_failures: numberValue(row.consecutive_failures),
    stale_minutes: numberValue(row.stale_minutes),
  }
}

function unpricedEvidence(row: Record<string, unknown>): AlertEvidence {
  return {
    kind: 'unpriced_growth', window: windowValue(row.window),
    baseline_window: windowValue(row.baseline_window),
    current_ratio: numberValue(row.current_ratio), baseline_ratio: numberValue(row.baseline_ratio),
    increase_ratio: numberValue(row.increase_ratio), sample_days: numberValue(row.sample_days),
    unpriced_tokens: numberValue(row.unpriced_tokens), total_tokens: numberValue(row.total_tokens),
  }
}

function evidenceValue(value: unknown): AlertEvidence {
  const row = objectValue(value, 'alert evidence')
  const kind = literalValue(row.kind, KINDS)
  if (kind === 'budget') return budgetEvidence(row)
  if (kind === 'spike') return spikeEvidence(row)
  if (kind === 'source_health') return sourceEvidence(row)
  return unpricedEvidence(row)
}

function evaluationValue(value: unknown): AlertRuleEvaluation {
  const row = objectValue(value, 'alert evaluation')
  return {
    rule_id: numberValue(row.rule_id), evaluated_at: stringValue(row.evaluated_at),
    status: literalValue(row.status, EVALUATION_STATUSES), reason: stringValue(row.reason),
    evidence: row.evidence === null ? null : evidenceValue(row.evidence),
  }
}

function ruleWithEvaluation(value: unknown): AlertRuleWithEvaluation {
  const row = objectValue(value, 'alert rule with evaluation')
  return {
    ...ruleValue(row),
    evaluation: row.evaluation === null ? null : evaluationValue(row.evaluation),
  }
}

function eventValue(value: unknown): AlertEvent {
  const row = objectValue(value, 'alert event')
  return {
    id: numberValue(row.id), rule_id: numberValue(row.rule_id),
    rule_name: stringValue(row.rule_name), kind: literalValue(row.kind, KINDS),
    device_id: nullableString(row.device_id), provider: nullableString(row.provider),
    dedup_key: stringValue(row.dedup_key), status: literalValue(row.status, EVENT_STATUSES),
    severity: literalValue(row.severity, SEVERITIES),
    first_triggered_at: stringValue(row.first_triggered_at),
    last_triggered_at: stringValue(row.last_triggered_at),
    recovered_at: nullableString(row.recovered_at),
    acknowledged_at: nullableString(row.acknowledged_at),
    cooldown_until: stringValue(row.cooldown_until),
    notification_status: literalValue(row.notification_status, NOTIFICATION_STATUSES),
    evidence: evidenceValue(row.evidence),
  }
}

export function decodeAlertCenter(value: unknown): AlertCenterResponse {
  const row = objectValue(value, 'alert center')
  return {
    webhook_configured: booleanValue(row.webhook_configured),
    rules: arrayValue(row.rules).map(ruleWithEvaluation),
    events: arrayValue(row.events).map(eventValue),
  }
}

export function decodeAlertRuleResponse(value: unknown): AlertRuleResponse {
  const row = objectValue(value, 'alert rule response')
  return { rule: ruleWithEvaluation(row.rule) }
}

export function decodeAlertEvaluation(value: unknown): AlertEvaluationResponse {
  const row = objectValue(value, 'alert evaluation response')
  return { ...decodeAlertCenter(row), evaluated_at: stringValue(row.evaluated_at) }
}
