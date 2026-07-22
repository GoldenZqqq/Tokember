import type { CostCoverage } from '@tokember/contracts/stats'
import type { AlertRule } from '@tokember/contracts/alerts'
import type { DB } from '../db.js'
import { buildAuthoritativeSourceFilter } from '../source-authority.js'
import {
  buildCostCoverage,
  INCOMPLETE_PRICING_STATUSES,
  realTotalTokensSql,
} from '../usage-metrics.js'
import type { UtcWindow } from './calendar.js'

export interface AlertAggregate {
  calls: number
  tokens: number
  cost: number
  unpriced_calls: number
  unpriced_tokens: number
  pricing_coverage: CostCoverage
}

interface AggregateRow {
  calls: number | null
  tokens: number | null
  cost: number | null
  unpriced_calls: number | null
  unpriced_tokens: number | null
}

function value(input: number | null): number {
  const result = Number(input)
  return Number.isFinite(result) ? result : 0
}

function rowToAggregate(row: AggregateRow): AlertAggregate {
  const calls = value(row.calls)
  const tokens = value(row.tokens)
  const unpricedCalls = value(row.unpriced_calls)
  const unpricedTokens = value(row.unpriced_tokens)
  return {
    calls, tokens, cost: value(row.cost),
    unpriced_calls: unpricedCalls, unpriced_tokens: unpricedTokens,
    pricing_coverage: buildCostCoverage(calls, tokens, unpricedCalls, unpricedTokens),
  }
}

export function captureAlertSnapshot(db: DB): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM usage_records').get() as { id: number | null }
  return value(row.id)
}

function aggregateQuery(maxRecordId: number): string {
  const total = realTotalTokensSql('u')
  const incomplete = INCOMPLETE_PRICING_STATUSES.map(status => `'${status}'`).join(', ')
  return `SELECT SUM(u.request_count) AS calls, SUM(${total}) AS tokens,
    SUM(u.cost_usd) AS cost,
    SUM(CASE WHEN u.pricing_status IN (${incomplete}) THEN u.request_count ELSE 0 END)
      AS unpriced_calls,
    SUM(CASE WHEN u.pricing_status IN (${incomplete}) THEN ${total} ELSE 0 END)
      AS unpriced_tokens
    FROM usage_records u
    WHERE u.timestamp >= ? AND u.timestamp < ? AND u.id <= ?
      AND ${buildAuthoritativeSourceFilter('u', maxRecordId)}
      AND (? IS NULL OR u.device_id = ?)
      AND (? IS NULL OR u.provider = ?)`
}

export class AlertMetricReader {
  private readonly cache = new Map<string, AlertAggregate>()

  constructor(private readonly db: DB, readonly maxRecordId: number) {}

  read(rule: Pick<AlertRule, 'device_id' | 'provider'>, window: UtcWindow): AlertAggregate {
    const key = JSON.stringify([rule.device_id, rule.provider, window.since, window.until])
    const cached = this.cache.get(key)
    if (cached) return cached
    const row = this.db.prepare(aggregateQuery(this.maxRecordId)).get(
      window.since, window.until, this.maxRecordId,
      rule.device_id, rule.device_id, rule.provider, rule.provider,
    ) as AggregateRow
    const aggregate = rowToAggregate(row)
    this.cache.set(key, aggregate)
    return aggregate
  }
}
