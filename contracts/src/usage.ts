export interface TokenInclusionSemantics {
  input_includes_cache_read: boolean
  input_includes_cache_creation: boolean
  output_includes_reasoning: boolean
}

export type AttributionStatus = 'captured' | 'disabled' | 'unsupported'

export interface UsageRecord extends TokenInclusionSemantics {
  provider: string
  model: string
  request_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  reasoning_tokens: number
  cost_usd: number
  timestamp: string
  source_file: string
  dedup_key: string
  cost_provided?: boolean
  attribution_version?: 1
  attribution_status?: AttributionStatus
  project_id?: string
  session_id?: string
}

export interface IngestResultCounts {
  created: number
  updated: number
  unchanged: number
  total: number
  /** @deprecated Use created + updated, or the precise counters directly. */
  inserted: number
}

export interface IngestSuccessResponse extends IngestResultCounts {
  ok: true
}
