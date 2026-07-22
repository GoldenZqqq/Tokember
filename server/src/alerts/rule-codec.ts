import type {
  AlertRuleConfig,
  AlertRuleInput,
  AlertRuleKind,
} from '@tokember/contracts/alerts'

const KINDS: AlertRuleKind[] = ['budget', 'spike', 'source_health', 'unpriced_growth']

export class AlertRuleValidationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid alert rule field: ${field}`)
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AlertRuleValidationError(field)
  }
  return value as Record<string, unknown>
}

function boundedString(value: unknown, field: string, max: number): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max) throw new AlertRuleValidationError(field)
  return result
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === null || value === '') return null
  return boundedString(value, field, max)
}

function finiteNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum) throw new AlertRuleValidationError(field)
  return value
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = finiteNumber(value, field, minimum, maximum)
  if (!Number.isInteger(parsed)) throw new AlertRuleValidationError(field)
  return parsed
}

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function budgetConfig(raw: Record<string, unknown>): AlertRuleConfig {
  const period = raw.period
  const metric = raw.metric
  if (period !== 'day' && period !== 'month') throw new AlertRuleValidationError('config.period')
  if (metric !== 'cost' && metric !== 'tokens') throw new AlertRuleValidationError('config.metric')
  return { period, metric, limit: finiteNumber(raw.limit, 'config.limit', Number.EPSILON) }
}

function spikeConfig(raw: Record<string, unknown>): AlertRuleConfig {
  const metric = raw.metric
  if (metric !== 'cost' && metric !== 'tokens') throw new AlertRuleValidationError('config.metric')
  return {
    metric,
    multiplier: finiteNumber(raw.multiplier, 'config.multiplier', 1 + Number.EPSILON, 1000),
    baseline_days: integer(raw.baseline_days, 'config.baseline_days', 3, 30),
    minimum_value: finiteNumber(raw.minimum_value, 'config.minimum_value', 0),
  }
}

function sourceHealthConfig(raw: Record<string, unknown>): AlertRuleConfig {
  return {
    consecutive_failures: integer(
      raw.consecutive_failures, 'config.consecutive_failures', 1, 100,
    ),
    stale_minutes: integer(raw.stale_minutes, 'config.stale_minutes', 1, 10080),
  }
}

function unpricedGrowthConfig(raw: Record<string, unknown>): AlertRuleConfig {
  return {
    baseline_days: integer(raw.baseline_days, 'config.baseline_days', 3, 30),
    increase_ratio: finiteNumber(raw.increase_ratio, 'config.increase_ratio', 0, 1),
    minimum_current_ratio: finiteNumber(
      raw.minimum_current_ratio, 'config.minimum_current_ratio', 0, 1,
    ),
  }
}

export function decodeAlertRuleConfig(kind: AlertRuleKind, value: unknown): AlertRuleConfig {
  const raw = objectValue(value, 'config')
  if (kind === 'budget') return budgetConfig(raw)
  if (kind === 'spike') return spikeConfig(raw)
  if (kind === 'source_health') return sourceHealthConfig(raw)
  return unpricedGrowthConfig(raw)
}

export function decodeAlertRuleInput(value: unknown): AlertRuleInput {
  const raw = objectValue(value, 'rule')
  const kind = raw.kind as AlertRuleKind
  if (!KINDS.includes(kind)) throw new AlertRuleValidationError('kind')
  const timezone = boundedString(raw.timezone, 'timezone', 120)
  if (!validTimeZone(timezone)) throw new AlertRuleValidationError('timezone')
  if (typeof raw.enabled !== 'boolean') throw new AlertRuleValidationError('enabled')
  if (typeof raw.notify_webhook !== 'boolean') {
    throw new AlertRuleValidationError('notify_webhook')
  }
  return {
    name: boundedString(raw.name, 'name', 120), kind,
    device_id: optionalString(raw.device_id, 'device_id', 120),
    provider: optionalString(raw.provider, 'provider', 80), timezone,
    enabled: raw.enabled,
    cooldown_minutes: integer(raw.cooldown_minutes, 'cooldown_minutes', 0, 10080),
    notify_webhook: raw.notify_webhook,
    config: decodeAlertRuleConfig(kind, raw.config),
  } as AlertRuleInput
}
