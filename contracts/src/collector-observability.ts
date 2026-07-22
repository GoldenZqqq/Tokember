export type CollectorKind = 'native' | 'hermes'

export type CollectorRunStatus = 'success' | 'partial' | 'failed'

export type CollectorSourceStatus =
  | 'success'
  | 'collection_failed'
  | 'upload_failed'

export interface CollectorUploadCounts {
  emitted: number
  accepted: number | null
  unchanged: number | null
}

export interface CollectorSourceReport extends CollectorUploadCounts {
  source: string
  status: CollectorSourceStatus
  discovered: number
  scanned: number
  watermark_at: string | null
  last_usage_at: string | null
  duration_ms: number
  error_summary: string | null
}

export interface CollectorRunReport extends CollectorUploadCounts {
  schema_version: 1
  run_id: string
  device_id: string
  collector_kind: CollectorKind
  collector_version: string
  schedule_interval_minutes: number
  started_at: string
  finished_at: string
  status: CollectorRunStatus
  duration_ms: number
  error_summary: string | null
  sources: CollectorSourceReport[]
}

export interface CollectorRunAcknowledgement {
  ok: true
  run_id: string
}

export interface CollectorRunSummary extends CollectorUploadCounts {
  run_id: string
  status: CollectorRunStatus
  started_at: string
  finished_at: string
  duration_ms: number
  schedule_interval_minutes: number
  error_summary: string | null
}

export interface CollectorSourceHealth extends CollectorSourceReport {
  finished_at: string
  consecutive_failures: number
}

export type CollectorDeviceStatus = 'healthy' | 'degraded' | 'offline' | 'never'

export interface CollectorDeviceHealth {
  status: CollectorDeviceStatus
  online: boolean
  freshness_threshold_minutes: number | null
  last_successful_at: string | null
  latest_run: CollectorRunSummary | null
  sources: CollectorSourceHealth[]
}
