export interface CostCoverage {
  priced_calls: number
  unpriced_calls: number
  priced_tokens: number
  unpriced_tokens: number
  call_ratio: number
  token_ratio: number
}

export interface QuerySnapshot {
  since: string
  until: string
  timezone_offset: number
  max_record_id: number
}

export interface StatsTotals {
  total_calls: number
  total_input: number
  total_output: number
  total_cache_read: number
  total_cache_creation: number
  real_total_tokens: number
  total_cost: number
  pricing_coverage: CostCoverage
}

export interface StatsAggregateRow {
  calls: number
  real_total_tokens: number
  cost: number
  pricing_coverage: CostCoverage
}

export interface ProviderStatsRow extends StatsAggregateRow {
  provider: string
  tokens: number
}

export interface ModelStatsRow extends StatsAggregateRow {
  model: string
  provider: string
  tokens: number
  input_tokens: number
  output_tokens: number
  unpriced_calls: number
}

export interface DeviceStatsRow extends StatsAggregateRow {
  device: string
  provider: string
}

export type AttributionDisplayStatus = 'captured' | 'disabled' | 'unsupported' | 'unknown'

export interface AttributionStatusRow extends StatsAggregateRow {
  status: AttributionDisplayStatus
  records: number
}

export interface ProjectStatsRow extends StatsAggregateRow {
  group_id: number | null
  name: string
  members: number
}

export interface SessionStatsRow extends StatsAggregateRow {
  session_id: string
  project_group_id: number | null
  project_name: string | null
}

export interface TrendStatsRow extends StatsAggregateRow {
  date: string
  since: string
  until: string
  tokens: number
  input_tokens: number
  output_tokens: number
}

export interface StatsResponse {
  snapshot: QuerySnapshot
  totals: StatsTotals
  byProvider: ProviderStatsRow[]
  byModel: ModelStatsRow[]
  byDevice: DeviceStatsRow[]
  attribution: AttributionStatusRow[]
  projectOptions: ProjectStatsRow[]
  byProject: ProjectStatsRow[]
  bySession: SessionStatsRow[]
  daily: TrendStatsRow[]
}

export interface YearStatsRow extends StatsAggregateRow {
  date: string
  since: string
  until: string
}

export interface MonthStatsRow extends StatsAggregateRow {
  month: string
  since: string
  until: string
}

export interface YearStatsResponse {
  year: number
  available_years: number[]
  snapshot: QuerySnapshot
  totals: {
    total_cost: number
    total_calls: number
    real_total_tokens: number
    active_days: number
    pricing_coverage: CostCoverage
  }
  peak: { date: string; cost: number }
  daily: YearStatsRow[]
  monthly: MonthStatsRow[]
}
