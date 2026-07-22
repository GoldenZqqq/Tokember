import type { BuildInfo } from '@tokember/contracts/release'
import type { CollectorDeviceHealth } from '@tokember/contracts/collector-observability'
import type { MachinePlatform } from '@tokember/contracts/device'

export type PricingMode = 'priced' | 'free' | 'included'

export interface ModelAlias {
  id: number
  pricing_rule_id: number
  source: string
  alias: string
  created_at: string
}

export interface PricingRule {
  id: number
  source: string | null
  model: string
  mode: PricingMode
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  enabled: number
  created_at: string
  updated_at: string
  aliases: ModelAlias[]
}

export type PricingRuleInput = Omit<PricingRule, 'id' | 'created_at' | 'updated_at' | 'aliases'>

export interface RepriceResult {
  matched: number
  cost_delta: number
  applied: boolean
}

export interface DeviceSummary {
  id: string
  name: string
  created_at: string
  last_seen_at: string | null
  prev_seen_at: string | null
  platform: MachinePlatform | null
  architecture: string | null
  hostname: string | null
  record_count: number
  last_record_at: string | null
  collector: CollectorDeviceHealth
}

export interface MaintenanceSummary {
  unpriced_count: number
  ignored_count: number
  placeholder_unpriced_count: number
  by_model: { model: string; provider: string; count: number }[]
  reprice: RepriceResult
  default_pattern: string
}

export interface MaintenanceActionResult {
  affected: number
  pattern: string
}

export type RecoveryState = 'never' | 'healthy' | 'stale' | 'backup_failed' | 'drill_failed'
export type RecoveryCheckState = 'never' | 'passed' | 'failed'
export type RecoveryErrorCode =
  | 'busy' | 'timeout' | 'io' | 'checksum' | 'schema' | 'integrity'
  | 'smoke' | 'status'

export interface RecoveryStatus {
  state: RecoveryState
  last_attempt_at: string | null
  last_success_at: string | null
  last_failure_at: string | null
  age_seconds: number | null
  backup_bytes: number | null
  schema_version: number | null
  integrity: RecoveryCheckState
  error_code: RecoveryErrorCode | null
  drill: {
    state: RecoveryCheckState
    last_attempt_at: string | null
    last_success_at: string | null
    duration_ms: number | null
  }
}

export interface ClassifyModelResult {
  affected: number
  repriced: number
  cost_delta: number
  source: string
  alias: string
  model: string
}

export interface SystemInfo {
  version: string
  build?: BuildInfo
  started_at: string
  node_env: string
  runtime_node_version?: string
  runtime_architecture?: string
  db_path: string
  db_ok: boolean
  counts: { devices: number; usage_records: number; pricing_rules: number }
  pricing_status: { status: string; count: number }[]
  recovery: RecoveryStatus
  devices: {
    id: string
    name: string
    last_seen_at: string | null
    last_successful_run_at: string | null
    collector_status: 'healthy' | 'degraded' | 'offline' | 'never'
    schedule_interval_minutes: number | null
    online: boolean
    record_count: number
  }[]
  health: {
    status: 'ok' | 'degraded' | 'error'
    online_devices: number
    offline_devices: number
    notes: string[]
  }
}
