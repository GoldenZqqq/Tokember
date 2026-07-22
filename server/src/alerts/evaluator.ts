import type {
  AlertEvidence,
  AlertRule,
  AlertRuleEvaluation,
  AlertSeverity,
} from '@tokember/contracts/alerts'
import type { CollectorDeviceHealth } from '@tokember/contracts/collector-observability'
import type { DB } from '../db.js'
import { getCollectorHealthMap } from '../collector-health.js'
import { completeLocalDayWindows, localPeriodWindow, type UtcWindow } from './calendar.js'
import { AlertMetricReader, captureAlertSnapshot, type AlertAggregate } from './metrics.js'
import { listAlertRules } from './store.js'

export interface AlertObservation {
  dedup_key: string
  severity: AlertSeverity
  evidence: AlertEvidence
}

export interface EvaluatedRule {
  rule: AlertRule
  evaluation: AlertRuleEvaluation
  observations: AlertObservation[]
  recover_missing: boolean
}

interface EvaluationContext {
  db: DB
  now: Date
  reader: AlertMetricReader
  health: Map<string, CollectorDeviceHealth>
  deviceIds: string[]
}

function metricValue(aggregate: AlertAggregate, metric: 'cost' | 'tokens'): number {
  return metric === 'cost' ? aggregate.cost : aggregate.tokens
}

function incomplete(aggregate: AlertAggregate, metric: 'cost' | 'tokens'): boolean {
  return metric === 'cost' && (
    aggregate.pricing_coverage.call_ratio < 1 || aggregate.pricing_coverage.token_ratio < 1
  )
}

function projection(value: number, window: UtcWindow, now: Date): number {
  const since = Date.parse(window.since)
  const until = Date.parse(window.until)
  const elapsed = Math.min(Math.max(now.getTime() - since, 0), until - since)
  return elapsed > 0 ? value / elapsed * (until - since) : value
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function evaluation(
  rule: AlertRule,
  now: Date,
  status: AlertRuleEvaluation['status'],
  reason: string,
  evidence: AlertEvidence | null,
): AlertRuleEvaluation {
  return { rule_id: rule.id, evaluated_at: now.toISOString(), status, reason, evidence }
}

function budgetEvaluation(rule: Extract<AlertRule, { kind: 'budget' }>, context: EvaluationContext) {
  const window = localPeriodWindow(context.now, rule.config.period, rule.timezone)
  const aggregate = context.reader.read(rule, window)
  const used = metricValue(aggregate, rule.config.metric)
  const ratio = used / rule.config.limit
  const forecast = projection(used, window, context.now)
  const thresholds = [0.5, 0.8, 1].filter(threshold => ratio >= threshold)
  const evidence = (threshold: number | null): AlertEvidence => ({
    kind: 'budget', metric: rule.config.metric, period: rule.config.period,
    window, used, limit: rule.config.limit, ratio, forecast,
    forecast_incomplete: incomplete(aggregate, rule.config.metric), threshold,
  })
  const observations = thresholds.map(threshold => ({
    dedup_key: `rule:${rule.id}:budget:${window.since}:${threshold}`,
    severity: (threshold >= 1 ? 'critical' : threshold >= 0.8 ? 'warning' : 'info') as AlertSeverity,
    evidence: evidence(threshold),
  }))
  const status = observations.length ? 'triggered' : 'ok'
  return {
    rule, observations, recover_missing: true,
    evaluation: evaluation(
      rule, context.now, status,
      observations.length ? `预算已达到 ${(thresholds.at(-1)! * 100).toFixed(0)}%` : '预算使用正常',
      evidence(thresholds.at(-1) ?? null),
    ),
  } satisfies EvaluatedRule
}

function historyAggregates(
  rule: AlertRule,
  context: EvaluationContext,
  days: number,
): { windows: UtcWindow[]; values: AlertAggregate[] } {
  const windows = completeLocalDayWindows(context.now, rule.timezone, days)
  return { windows, values: windows.map(window => context.reader.read(rule, window)) }
}

function spikeEvaluation(rule: Extract<AlertRule, { kind: 'spike' }>, context: EvaluationContext) {
  const window = localPeriodWindow(context.now, 'day', rule.timezone)
  const currentAggregate = context.reader.read(rule, window)
  const history = historyAggregates(rule, context, rule.config.baseline_days)
  const samples = history.values.filter(item => item.calls > 0 || item.tokens > 0)
  const values = samples.map(item => metricValue(item, rule.config.metric))
  if (samples.length < 3 || median(values) <= 0) {
    return insufficient(rule, context.now, '历史基线不足，至少需要 3 个非空完整日')
  }
  const baseline = median(values)
  const current = metricValue(currentAggregate, rule.config.metric)
  const forecast = projection(current, window, context.now)
  const multiplier = forecast / baseline
  const evidence: AlertEvidence = {
    kind: 'spike', metric: rule.config.metric, window,
    baseline_window: { since: history.windows[0].since, until: history.windows.at(-1)!.until },
    current, forecast, baseline, multiplier, sample_days: samples.length,
    forecast_incomplete: incomplete(currentAggregate, rule.config.metric),
  }
  const triggered = forecast >= rule.config.minimum_value && multiplier >= rule.config.multiplier
  return observed(rule, context.now, evidence, triggered, 'spike', multiplier >= rule.config.multiplier * 1.5)
}

function unpricedEvaluation(
  rule: Extract<AlertRule, { kind: 'unpriced_growth' }>,
  context: EvaluationContext,
) {
  const window = localPeriodWindow(context.now, 'day', rule.timezone)
  const current = context.reader.read(rule, window)
  const history = historyAggregates(rule, context, rule.config.baseline_days)
  const samples = history.values.filter(item => item.tokens > 0)
  if (samples.length < 3) return insufficient(rule, context.now, '历史基线不足，至少需要 3 个有 Tokens 的完整日')
  const currentRatio = current.tokens > 0 ? current.unpriced_tokens / current.tokens : 0
  const baselineRatio = median(samples.map(item => item.unpriced_tokens / item.tokens))
  const increaseRatio = currentRatio - baselineRatio
  const evidence: AlertEvidence = {
    kind: 'unpriced_growth', window,
    baseline_window: { since: history.windows[0].since, until: history.windows.at(-1)!.until },
    current_ratio: currentRatio, baseline_ratio: baselineRatio,
    increase_ratio: increaseRatio, sample_days: samples.length,
    unpriced_tokens: current.unpriced_tokens, total_tokens: current.tokens,
  }
  const triggered = currentRatio >= rule.config.minimum_current_ratio
    && increaseRatio >= rule.config.increase_ratio
  return observed(rule, context.now, evidence, triggered, 'unpriced_growth', false)
}

function sourceState(
  rule: Extract<AlertRule, { kind: 'source_health' }>,
  context: EvaluationContext,
  deviceId: string,
): AlertObservation | null {
  const health = context.health.get(deviceId)
  const source = rule.provider ? health?.sources.find(item => item.source === rule.provider) : null
  const lastRun = source?.finished_at ?? health?.latest_run?.finished_at ?? null
  const failures = source?.consecutive_failures
    ?? Math.max(0, ...(health?.sources.map(item => item.consecutive_failures) ?? []))
  const stale = !lastRun || context.now.getTime() - Date.parse(lastRun)
    >= rule.config.stale_minutes * 60_000
  const state = !health || !lastRun ? 'never'
    : failures >= rule.config.consecutive_failures ? 'failed'
      : stale ? 'stale' : null
  if (!state) return null
  return {
    dedup_key: `rule:${rule.id}:source_health:${deviceId}:${rule.provider ?? '*'}`,
    severity: state === 'never' || state === 'stale' ? 'critical' : 'warning',
    evidence: {
      kind: 'source_health', device_id: deviceId, source: rule.provider,
      state, last_run_at: lastRun, consecutive_failures: failures,
      stale_minutes: rule.config.stale_minutes,
    },
  }
}

function sourceHealthEvaluation(
  rule: Extract<AlertRule, { kind: 'source_health' }>,
  context: EvaluationContext,
) {
  const devices = rule.device_id ? [rule.device_id] : context.deviceIds
  if (devices.length === 0) return insufficient(rule, context.now, '尚无设备可评估')
  const observations = devices.map(device => sourceState(rule, context, device))
    .filter((item): item is AlertObservation => item != null)
  return {
    rule, observations, recover_missing: true,
    evaluation: evaluation(
      rule, context.now, observations.length ? 'triggered' : 'ok',
      observations.length ? `${observations.length} 个来源健康异常` : '来源健康正常',
      observations[0]?.evidence ?? null,
    ),
  } satisfies EvaluatedRule
}

function observed(
  rule: AlertRule,
  now: Date,
  evidence: AlertEvidence,
  triggered: boolean,
  suffix: string,
  critical: boolean,
): EvaluatedRule {
  const observations = triggered ? [{
    dedup_key: `rule:${rule.id}:${suffix}`,
    severity: (critical ? 'critical' : 'warning') as AlertSeverity, evidence,
  }] : []
  return {
    rule, observations, recover_missing: true,
    evaluation: evaluation(
      rule, now, triggered ? 'triggered' : 'ok',
      triggered ? '检测到异常增长' : '当前指标处于基线范围', evidence,
    ),
  }
}

function insufficient(rule: AlertRule, now: Date, reason: string): EvaluatedRule {
  return {
    rule, observations: [], recover_missing: true,
    evaluation: evaluation(rule, now, 'insufficient_data', reason, null),
  }
}

function evaluateRule(rule: AlertRule, context: EvaluationContext): EvaluatedRule {
  if (rule.kind === 'budget') return budgetEvaluation(rule, context)
  if (rule.kind === 'spike') return spikeEvaluation(rule, context)
  if (rule.kind === 'source_health') return sourceHealthEvaluation(rule, context)
  return unpricedEvaluation(rule, context)
}

export function evaluateEnabledAlertRules(db: DB, now = new Date()): EvaluatedRule[] {
  const context: EvaluationContext = {
    db, now, reader: new AlertMetricReader(db, captureAlertSnapshot(db)),
    health: getCollectorHealthMap(db),
    deviceIds: (db.prepare('SELECT id FROM devices ORDER BY id').all() as { id: string }[])
      .map(row => row.id),
  }
  return listAlertRules(db).filter(rule => rule.enabled).map(rule => {
    try {
      return evaluateRule(rule, context)
    } catch {
      return {
        rule, observations: [], recover_missing: false,
        evaluation: evaluation(rule, now, 'error', '规则评估失败', null),
      }
    }
  })
}
