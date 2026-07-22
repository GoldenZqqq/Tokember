import type {
  AuditAdminRecord,
  AuditPublicRecord,
  AuditCutoverPage,
  AuditMetricSummary,
  AuditPricingExplanation,
  AuditPricingRule,
  AuditReconciliationResponse,
  AuditRecordsPage,
  AuditSummaryResponse,
  AuditVisibility,
  PricingStatus,
} from '@tokember/contracts/audit'
import {
  arrayValue, booleanValue, literalValue, nullableString, numberValue,
  objectValue, stringValue,
} from '../data/decoders'
import { decodeCostCoverage, decodeQuerySnapshot } from '../data/public-decoders'

const VISIBILITIES: AuditVisibility[] = ['authoritative', 'physical', 'hidden']
const PRICING_STATUSES: PricingStatus[] = [
  'provided', 'priced', 'free', 'included', 'unpriced', 'none', 'ignored',
]
const EXPLANATION_STATUSES = [
  'exact', 'rule_drift', 'legacy_unknown', 'not_applicable',
] as const

function nullableNumber(value: unknown): number | null {
  return value == null ? null : numberValue(value)
}

function pricingRule(value: unknown): AuditPricingRule {
  const row = objectValue(value, 'audit pricing rule')
  return {
    id: numberValue(row.id), source: nullableString(row.source), model: stringValue(row.model),
    mode: literalValue(row.mode, ['priced', 'free', 'included'] as const),
    input_price: numberValue(row.input_price), output_price: numberValue(row.output_price),
    cache_read_price: numberValue(row.cache_read_price),
    cache_write_price: numberValue(row.cache_write_price), enabled: booleanValue(row.enabled),
    aliases: arrayValue(row.aliases).map(value => {
      const alias = objectValue(value, 'audit alias')
      return { source: stringValue(alias.source), alias: stringValue(alias.alias) }
    }),
  }
}

function explanation(value: unknown): AuditPricingExplanation {
  const row = objectValue(value, 'pricing explanation')
  return {
    status: literalValue(row.status, EXPLANATION_STATUSES),
    recomputed_cost_usd: nullableNumber(row.recomputed_cost_usd),
    current_rule: row.current_rule == null ? null : pricingRule(row.current_rule),
    evidence: stringValue(row.evidence),
  }
}

function publicAuditRecord(value: unknown): AuditPublicRecord {
  const row = objectValue(value, 'audit record')
  return {
    id: numberValue(row.id), device_id: stringValue(row.device_id),
    device_name: stringValue(row.device_name), provider: stringValue(row.provider),
    model: stringValue(row.model), request_count: numberValue(row.request_count),
    input_tokens: numberValue(row.input_tokens), output_tokens: numberValue(row.output_tokens),
    cache_read_tokens: numberValue(row.cache_read_tokens),
    cache_creation_tokens: numberValue(row.cache_creation_tokens),
    reasoning_tokens: numberValue(row.reasoning_tokens),
    input_includes_cache_read: booleanValue(row.input_includes_cache_read),
    input_includes_cache_creation: booleanValue(row.input_includes_cache_creation),
    output_includes_reasoning: booleanValue(row.output_includes_reasoning),
    fresh_input_tokens: numberValue(row.fresh_input_tokens),
    billable_output_tokens: numberValue(row.billable_output_tokens),
    real_total_tokens: numberValue(row.real_total_tokens), cost_usd: numberValue(row.cost_usd),
    pricing_status: literalValue(row.pricing_status, PRICING_STATUSES),
    timestamp: stringValue(row.timestamp),
    attribution_version: row.attribution_version == null
      ? null : numberValue(row.attribution_version),
    attribution_status: 'attribution_status' in row
      ? literalValue(row.attribution_status, ['captured', 'disabled', 'unsupported', 'unknown'] as const)
      : 'unknown',
    project_id: 'project_id' in row ? nullableString(row.project_id) : null,
    session_id: 'session_id' in row ? nullableString(row.session_id) : null,
    project_group_id: row.project_group_id == null ? null : numberValue(row.project_group_id),
    project_name: 'project_name' in row ? nullableString(row.project_name) : null,
  }
}

function auditRecord(value: unknown): AuditAdminRecord {
  const row = objectValue(value, 'audit record')
  return {
    ...publicAuditRecord(row),
    source_file: nullableString(row.source_file),
    dedup_key: nullableString(row.dedup_key), pricing_rule_id: nullableNumber(row.pricing_rule_id),
    pricing_source: nullableString(row.pricing_source), created_at: nullableString(row.created_at),
    is_authoritative: booleanValue(row.is_authoritative),
    pricing_explanation: explanation(row.pricing_explanation),
  }
}

export function decodeAuditRecords(value: unknown): AuditRecordsPage<AuditAdminRecord> {
  const row = objectValue(value, 'audit records')
  return {
    snapshot: decodeQuerySnapshot(row.snapshot),
    visibility: literalValue(row.visibility, VISIBILITIES),
    rows: arrayValue(row.rows).map(auditRecord),
    next_cursor: nullableString(row.next_cursor),
  }
}

export function decodePublicAuditRecords(value: unknown): AuditRecordsPage<AuditPublicRecord> {
  const row = objectValue(value, 'public audit records')
  return {
    snapshot: decodeQuerySnapshot(row.snapshot),
    visibility: literalValue(row.visibility, VISIBILITIES),
    rows: arrayValue(row.rows).map(publicAuditRecord),
    next_cursor: nullableString(row.next_cursor),
  }
}

function metricSummary(value: unknown): AuditMetricSummary {
  const row = objectValue(value, 'audit summary')
  return {
    records: numberValue(row.records), calls: numberValue(row.calls),
    real_total_tokens: numberValue(row.real_total_tokens), cost_usd: numberValue(row.cost_usd),
    pricing_coverage: decodeCostCoverage(row.pricing_coverage),
    last_usage_at: nullableString(row.last_usage_at),
  }
}

export function decodeAuditSummary(value: unknown): AuditSummaryResponse {
  const row = objectValue(value, 'audit summaries')
  return {
    snapshot: decodeQuerySnapshot(row.snapshot), selected: metricSummary(row.selected),
    authoritative: metricSummary(row.authoritative), physical: metricSummary(row.physical),
    hidden: metricSummary(row.hidden),
  }
}

export function decodeAuditReconciliation(value: unknown): AuditReconciliationResponse {
  const row = objectValue(value, 'audit reconciliation')
  return {
    snapshot: decodeQuerySnapshot(row.snapshot), run_since: stringValue(row.run_since),
    run_until: stringValue(row.run_until),
    telemetry_coverage: (() => {
      const coverage = objectValue(row.telemetry_coverage, 'telemetry coverage')
      return {
        coverage_since: nullableString(coverage.coverage_since),
        earliest_retained_at: nullableString(coverage.earliest_retained_at),
        latest_retained_at: nullableString(coverage.latest_retained_at),
        truncated: booleanValue(coverage.truncated),
      }
    })(),
    rows: arrayValue(row.rows).map(value => {
      const source = objectValue(value, 'reconciliation source')
      return {
        device_id: stringValue(source.device_id), device_name: stringValue(source.device_name),
        source: stringValue(source.source), runs: numberValue(source.runs),
        successful_runs: numberValue(source.successful_runs), failed_runs: numberValue(source.failed_runs),
        emitted: numberValue(source.emitted), accepted: numberValue(source.accepted),
        unchanged: numberValue(source.unchanged),
        unknown_acknowledgements: numberValue(source.unknown_acknowledgements),
        pipeline_balance: numberValue(source.pipeline_balance),
        latest_watermark_at: nullableString(source.latest_watermark_at),
        reported_last_usage_at: nullableString(source.reported_last_usage_at),
        ledger: metricSummary(source.ledger),
      }
    }),
  }
}

export function decodeAuditCutovers(value: unknown): AuditCutoverPage {
  const row = objectValue(value, 'cutover events')
  return {
    rows: arrayValue(row.rows).map(value => {
      const event = objectValue(value, 'cutover event')
      return {
        id: numberValue(event.id), device_id: stringValue(event.device_id),
        device_name: stringValue(event.device_name), provider: stringValue(event.provider),
        previous_cutover_at: nullableString(event.previous_cutover_at),
        cutover_at: nullableString(event.cutover_at), actor: stringValue(event.actor),
        reason: stringValue(event.reason), created_at: stringValue(event.created_at),
      }
    }),
    next_cursor: nullableString(row.next_cursor),
  }
}
