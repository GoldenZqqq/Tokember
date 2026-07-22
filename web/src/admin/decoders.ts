import type { BuildInfo } from '@tokember/contracts/release'
import type {
  DeviceCredential,
  DeviceCredentialCreatedResponse,
  DeviceCredentialListResponse,
} from '@tokember/contracts/security'
import type {
  CollectorDeviceHealth,
  CollectorRunSummary,
  CollectorSourceHealth,
} from '@tokember/contracts/collector-observability'
import type {
  ProjectAttributionGroup,
  ProjectAttributionMember,
  ProjectAttributionMutationResponse,
  ProjectAttributionResponse,
} from '@tokember/contracts/attribution'
import {
  arrayValue, booleanValue, literalValue, nullableString, numberValue,
  objectValue, optionalString, stringValue, type JsonObject,
} from '../data/decoders'
import type {
  ClassifyModelResult, DeviceSummary, MaintenanceActionResult,
  MaintenanceSummary, ModelAlias, PricingMode, PricingRule,
  RepriceResult, SystemInfo,
} from './types'
import type { RecoveryStatus } from './types'
import { decodeCostCoverage } from '../data/public-decoders'

const PRICING_MODES: PricingMode[] = ['priced', 'free', 'included']
const RUN_STATUSES = ['success', 'partial', 'failed'] as const
const SOURCE_STATUSES = ['success', 'collection_failed', 'upload_failed'] as const
const DEVICE_STATUSES = ['healthy', 'degraded', 'offline', 'never'] as const
const MACHINE_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const
const RECOVERY_STATES = ['never', 'healthy', 'stale', 'backup_failed', 'drill_failed'] as const
const RECOVERY_CHECK_STATES = ['never', 'passed', 'failed'] as const
const RECOVERY_ERROR_CODES = [
  'busy', 'timeout', 'io', 'checksum', 'schema', 'integrity', 'smoke', 'status',
] as const

function nullableNumber(value: unknown): number | null {
  return value === null ? null : numberValue(value)
}

function stringRecord(value: unknown): Record<string, string> {
  const input = objectValue(value, 'runtime_dependencies')
  return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, stringValue(entry)]))
}

function buildInfo(value: unknown): BuildInfo {
  const row = objectValue(value, 'build')
  if (numberValue(row.schema_version) !== 2) throw new Error('unsupported build schema')
  return {
    schema_version: 2,
    release_id: stringValue(row.release_id), version: stringValue(row.version),
    commit: stringValue(row.commit), built_at: stringValue(row.built_at),
    node_version: stringValue(row.node_version), architecture: stringValue(row.architecture),
    lockfile_sha256: stringValue(row.lockfile_sha256),
    runtime_dependencies: stringRecord(row.runtime_dependencies),
  }
}

function modelAlias(value: unknown): ModelAlias {
  const row = objectValue(value, 'model alias')
  return {
    id: numberValue(row.id), pricing_rule_id: numberValue(row.pricing_rule_id),
    source: stringValue(row.source), alias: stringValue(row.alias),
    created_at: stringValue(row.created_at),
  }
}

function pricingRule(value: unknown): PricingRule {
  const row = objectValue(value, 'pricing rule')
  return {
    id: numberValue(row.id), source: nullableString(row.source), model: stringValue(row.model),
    mode: literalValue(row.mode, PRICING_MODES), input_price: numberValue(row.input_price),
    output_price: numberValue(row.output_price), cache_read_price: numberValue(row.cache_read_price),
    cache_write_price: numberValue(row.cache_write_price), enabled: numberValue(row.enabled),
    created_at: stringValue(row.created_at), updated_at: stringValue(row.updated_at),
    aliases: arrayValue(row.aliases).map(modelAlias),
  }
}

export function decodeAuthenticated(value: unknown): { authenticated: boolean } {
  const row = objectValue(value)
  return { authenticated: booleanValue(row.authenticated) }
}

export function decodeOk(value: unknown): { ok: boolean } {
  const row = objectValue(value)
  return { ok: booleanValue(row.ok) }
}

export function decodeRules(value: unknown): { rules: PricingRule[] } {
  const row = objectValue(value)
  return { rules: arrayValue(row.rules).map(pricingRule) }
}

export function decodeRule(value: unknown): { rule: PricingRule } {
  const row = objectValue(value)
  return { rule: pricingRule(row.rule) }
}

function reprice(value: unknown): RepriceResult {
  const row = objectValue(value, 'reprice result')
  return {
    matched: numberValue(row.matched), cost_delta: numberValue(row.cost_delta),
    applied: booleanValue(row.applied),
  }
}

export const decodeReprice = reprice

function collectorRun(value: unknown): CollectorRunSummary {
  const row = objectValue(value, 'collector run')
  return {
    run_id: stringValue(row.run_id), status: literalValue(row.status, RUN_STATUSES),
    started_at: stringValue(row.started_at), finished_at: stringValue(row.finished_at),
    duration_ms: numberValue(row.duration_ms),
    schedule_interval_minutes: numberValue(row.schedule_interval_minutes),
    emitted: numberValue(row.emitted), accepted: nullableNumber(row.accepted),
    unchanged: nullableNumber(row.unchanged), error_summary: nullableString(row.error_summary),
  }
}

function collectorSource(value: unknown): CollectorSourceHealth {
  const row = objectValue(value, 'collector source')
  return {
    source: stringValue(row.source), status: literalValue(row.status, SOURCE_STATUSES),
    discovered: numberValue(row.discovered), scanned: numberValue(row.scanned),
    emitted: numberValue(row.emitted), accepted: nullableNumber(row.accepted),
    unchanged: nullableNumber(row.unchanged), watermark_at: nullableString(row.watermark_at),
    last_usage_at: nullableString(row.last_usage_at), duration_ms: numberValue(row.duration_ms),
    error_summary: nullableString(row.error_summary), finished_at: stringValue(row.finished_at),
    consecutive_failures: numberValue(row.consecutive_failures),
  }
}

function collectorHealth(value: unknown): CollectorDeviceHealth {
  const row = objectValue(value, 'collector health')
  return {
    status: literalValue(row.status, DEVICE_STATUSES), online: booleanValue(row.online),
    freshness_threshold_minutes: nullableNumber(row.freshness_threshold_minutes),
    last_successful_at: nullableString(row.last_successful_at),
    latest_run: row.latest_run === null ? null : collectorRun(row.latest_run),
    sources: arrayValue(row.sources).map(collectorSource),
  }
}

function deviceSummary(value: unknown): DeviceSummary {
  const row = objectValue(value, 'device')
  return {
    id: stringValue(row.id), name: stringValue(row.name),
    created_at: stringValue(row.created_at), last_seen_at: nullableString(row.last_seen_at),
    prev_seen_at: nullableString(row.prev_seen_at),
    platform: row.platform == null ? null : literalValue(row.platform, MACHINE_PLATFORMS),
    architecture: nullableString(row.architecture), hostname: nullableString(row.hostname),
    record_count: numberValue(row.record_count),
    last_record_at: nullableString(row.last_record_at),
    collector: collectorHealth(row.collector),
  }
}

export function decodeDevices(value: unknown): { devices: DeviceSummary[] } {
  const row = objectValue(value)
  return { devices: arrayValue(row.devices).map(deviceSummary) }
}

function deviceCredential(value: unknown): DeviceCredential {
  const row = objectValue(value, 'device credential')
  return {
    id: numberValue(row.id), token_id: stringValue(row.token_id),
    device_id: stringValue(row.device_id), device_name: stringValue(row.device_name),
    label: stringValue(row.label), created_at: stringValue(row.created_at),
    last_used_at: nullableString(row.last_used_at), revoked_at: nullableString(row.revoked_at),
  }
}

export function decodeDeviceCredentials(value: unknown): DeviceCredentialListResponse {
  const row = objectValue(value, 'device credentials')
  return {
    credentials: arrayValue(row.credentials).map(deviceCredential),
    legacy_api_key_allowed: booleanValue(row.legacy_api_key_allowed),
  }
}

export function decodeDeviceCredentialCreated(
  value: unknown,
): DeviceCredentialCreatedResponse {
  const row = objectValue(value, 'created device credential')
  return { credential: deviceCredential(row.credential), token: stringValue(row.token) }
}

export function decodeMaintenance(value: unknown): MaintenanceSummary {
  const row = objectValue(value, 'maintenance summary')
  return {
    unpriced_count: numberValue(row.unpriced_count), ignored_count: numberValue(row.ignored_count),
    placeholder_unpriced_count: numberValue(row.placeholder_unpriced_count),
    by_model: arrayValue(row.by_model).map(item => {
      const model = objectValue(item)
      return {
        model: stringValue(model.model), provider: stringValue(model.provider),
        count: numberValue(model.count),
      }
    }),
    reprice: reprice(row.reprice), default_pattern: stringValue(row.default_pattern),
  }
}

export function decodeMaintenanceAction(value: unknown): MaintenanceActionResult {
  const row = objectValue(value)
  return { affected: numberValue(row.affected), pattern: stringValue(row.pattern) }
}

export function decodeClassify(value: unknown): ClassifyModelResult {
  const row = objectValue(value)
  return {
    affected: numberValue(row.affected), repriced: numberValue(row.repriced),
    cost_delta: numberValue(row.cost_delta), source: stringValue(row.source),
    alias: stringValue(row.alias), model: stringValue(row.model),
  }
}

function systemDevice(value: unknown): SystemInfo['devices'][number] {
  const row = objectValue(value)
  const online = booleanValue(row.online)
  return {
    id: stringValue(row.id), name: stringValue(row.name),
    last_seen_at: nullableString(row.last_seen_at),
    last_successful_run_at: 'last_successful_run_at' in row
      ? nullableString(row.last_successful_run_at)
      : null,
    collector_status: 'collector_status' in row
      ? literalValue(row.collector_status, ['healthy', 'degraded', 'offline', 'never'] as const)
      : 'never',
    schedule_interval_minutes: 'schedule_interval_minutes' in row
      ? nullableNumber(row.schedule_interval_minutes)
      : null,
    online,
    record_count: numberValue(row.record_count),
  }
}

function systemHealth(value: unknown): SystemInfo['health'] {
  const row = objectValue(value, 'health')
  return {
    status: literalValue(row.status, ['ok', 'degraded', 'error'] as const),
    online_devices: numberValue(row.online_devices),
    offline_devices: numberValue(row.offline_devices),
    notes: arrayValue(row.notes).map(item => stringValue(item)),
  }
}

function neverRecovery(): RecoveryStatus {
  return {
    state: 'never', last_attempt_at: null, last_success_at: null, last_failure_at: null,
    age_seconds: null, backup_bytes: null, schema_version: null, integrity: 'never',
    error_code: null,
    drill: { state: 'never', last_attempt_at: null, last_success_at: null, duration_ms: null },
  }
}

function recoveryStatus(value: unknown): RecoveryStatus {
  const row = objectValue(value, 'recovery status')
  const drill = objectValue(row.drill, 'recovery drill')
  return {
    state: literalValue(row.state, RECOVERY_STATES),
    last_attempt_at: nullableString(row.last_attempt_at),
    last_success_at: nullableString(row.last_success_at),
    last_failure_at: nullableString(row.last_failure_at),
    age_seconds: nullableNumber(row.age_seconds),
    backup_bytes: nullableNumber(row.backup_bytes),
    schema_version: nullableNumber(row.schema_version),
    integrity: literalValue(row.integrity, RECOVERY_CHECK_STATES),
    error_code: row.error_code === null
      ? null : literalValue(row.error_code, RECOVERY_ERROR_CODES),
    drill: {
      state: literalValue(drill.state, RECOVERY_CHECK_STATES),
      last_attempt_at: nullableString(drill.last_attempt_at),
      last_success_at: nullableString(drill.last_success_at),
      duration_ms: nullableNumber(drill.duration_ms),
    },
  }
}

export function decodeSystemInfo(value: unknown): SystemInfo {
  const row = objectValue(value, 'system info')
  const counts = objectValue(row.counts, 'counts')
  return {
    version: stringValue(row.version), build: row.build == null ? undefined : buildInfo(row.build),
    started_at: stringValue(row.started_at), node_env: stringValue(row.node_env),
    runtime_node_version: optionalString(row.runtime_node_version),
    runtime_architecture: optionalString(row.runtime_architecture),
    db_path: stringValue(row.db_path), db_ok: booleanValue(row.db_ok),
    counts: {
      devices: numberValue(counts.devices), usage_records: numberValue(counts.usage_records),
      pricing_rules: numberValue(counts.pricing_rules),
    },
    pricing_status: arrayValue(row.pricing_status).map(item => {
      const status = objectValue(item)
      return { status: stringValue(status.status), count: numberValue(status.count) }
    }),
    recovery: row.recovery == null ? neverRecovery() : recoveryStatus(row.recovery),
    devices: arrayValue(row.devices).map(systemDevice), health: systemHealth(row.health),
  }
}

function attributionAggregate(row: JsonObject) {
  return {
    calls: numberValue(row.calls), real_total_tokens: numberValue(row.real_total_tokens),
    cost: numberValue(row.cost), pricing_coverage: decodeCostCoverage(row.pricing_coverage),
  }
}

function projectMember(value: unknown): ProjectAttributionMember {
  const row = objectValue(value, 'attribution project member')
  return {
    ...attributionAggregate(row), device_id: stringValue(row.device_id),
    device_name: stringValue(row.device_name), project_id: stringValue(row.project_id),
    first_seen_at: stringValue(row.first_seen_at), last_seen_at: stringValue(row.last_seen_at),
  }
}

function projectGroup(value: unknown): ProjectAttributionGroup {
  const row = objectValue(value, 'attribution project group')
  return {
    ...attributionAggregate(row), id: numberValue(row.id),
    display_name: nullableString(row.display_name),
    members: arrayValue(row.members).map(projectMember),
  }
}

export function decodeProjectAttribution(value: unknown): ProjectAttributionResponse {
  const row = objectValue(value, 'project attribution')
  return { groups: arrayValue(row.groups).map(projectGroup) }
}

export function decodeProjectAttributionMutation(
  value: unknown,
): ProjectAttributionMutationResponse {
  const row = objectValue(value, 'project attribution mutation')
  if (!booleanValue(row.ok)) throw new Error('invalid project attribution mutation')
  return { ok: true, group_id: numberValue(row.group_id) }
}
