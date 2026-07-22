import type { AttributionDisplayStatus, CostCoverage, QuerySnapshot } from './stats.js'

export type AuditVisibility = 'authoritative' | 'physical' | 'hidden'

export type PricingStatus =
  | 'provided'
  | 'priced'
  | 'free'
  | 'included'
  | 'unpriced'
  | 'none'
  | 'ignored'

export type PricingExplanationStatus =
  | 'exact'
  | 'rule_drift'
  | 'legacy_unknown'
  | 'not_applicable'

export interface AuditRecordMetrics {
  request_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  reasoning_tokens: number
  input_includes_cache_read: boolean
  input_includes_cache_creation: boolean
  output_includes_reasoning: boolean
  fresh_input_tokens: number
  billable_output_tokens: number
  real_total_tokens: number
}

export interface AuditPublicRecord extends AuditRecordMetrics {
  id: number
  device_id: string
  device_name: string
  provider: string
  model: string
  cost_usd: number
  pricing_status: PricingStatus
  timestamp: string
  attribution_version: number | null
  attribution_status: AttributionDisplayStatus
  project_id: string | null
  session_id: string | null
  project_group_id: number | null
  project_name: string | null
}

export interface AuditPricingRule {
  id: number
  source: string | null
  model: string
  mode: 'priced' | 'free' | 'included'
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  enabled: boolean
  aliases: Array<{ source: string; alias: string }>
}

export interface AuditPricingExplanation {
  status: PricingExplanationStatus
  recomputed_cost_usd: number | null
  current_rule: AuditPricingRule | null
  evidence: string
}

export interface AuditAdminRecord extends AuditPublicRecord {
  source_file: string | null
  dedup_key: string | null
  pricing_rule_id: number | null
  pricing_source: string | null
  created_at: string | null
  is_authoritative: boolean
  pricing_explanation: AuditPricingExplanation
}

export interface AuditRecordsPage<TRecord = AuditPublicRecord> {
  snapshot: QuerySnapshot
  visibility: AuditVisibility
  rows: TRecord[]
  next_cursor: string | null
}

export interface AuditMetricSummary {
  records: number
  calls: number
  real_total_tokens: number
  cost_usd: number
  pricing_coverage: CostCoverage
  last_usage_at: string | null
}

export interface AuditSummaryResponse {
  snapshot: QuerySnapshot
  selected: AuditMetricSummary
  authoritative: AuditMetricSummary
  physical: AuditMetricSummary
  hidden: AuditMetricSummary
}

export interface AuditReconciliationRow {
  device_id: string
  device_name: string
  source: string
  runs: number
  successful_runs: number
  failed_runs: number
  emitted: number
  accepted: number
  unchanged: number
  unknown_acknowledgements: number
  pipeline_balance: number
  latest_watermark_at: string | null
  reported_last_usage_at: string | null
  ledger: AuditMetricSummary
}

export interface AuditReconciliationResponse {
  snapshot: QuerySnapshot
  run_since: string
  run_until: string
  telemetry_coverage: {
    coverage_since: string | null
    earliest_retained_at: string | null
    latest_retained_at: string | null
    truncated: boolean
  }
  rows: AuditReconciliationRow[]
}

export interface AuditCutoverEvent {
  id: number
  device_id: string
  device_name: string
  provider: string
  previous_cutover_at: string | null
  cutover_at: string | null
  actor: string
  reason: string
  created_at: string
}

export interface AuditCutoverPage {
  rows: AuditCutoverEvent[]
  next_cursor: string | null
}
