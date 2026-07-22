import type { AuditVisibility, PricingStatus } from '@tokember/contracts/audit'
import type { QuerySnapshot } from '@tokember/contracts/stats'

const DAY_MS = 86_400_000
const VISIBILITIES: AuditVisibility[] = ['authoritative', 'physical', 'hidden']
const PRICING_STATUSES: PricingStatus[] = [
  'provided', 'priced', 'free', 'included', 'unpriced', 'none', 'ignored',
]

export interface AuditFilters {
  since: string
  until: string
  timezone_offset: number
  snapshot_max_id?: number
  device?: string
  provider?: string
  model?: string
  pricing_status?: PricingStatus
  source_marker?: string
  dedup_key?: string
  project_group_id?: number
  session_id?: string
  visibility: AuditVisibility
}

export interface AuditDimension {
  since?: string
  until?: string
  provider?: string
  model?: string
  project_group_id?: number
  session_id?: string
}

function optionalInteger(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function optionalTimezone(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= -840 && parsed <= 840 ? parsed : undefined
}

function defaultWindow(now = new Date()): Pick<AuditFilters, 'since' | 'until'> {
  return {
    since: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    until: now.toISOString(),
  }
}

export function filtersFromHash(hash: string, now = new Date()): AuditFilters {
  const query = new URLSearchParams(hash.split('?')[1] ?? '')
  const fallback = defaultWindow(now)
  const visibility = query.get('visibility') as AuditVisibility | null
  const pricingStatus = query.get('pricing_status') as PricingStatus | null
  return {
    since: query.get('since') || fallback.since,
    until: query.get('until') || fallback.until,
    timezone_offset: optionalTimezone(query.get('timezone_offset'))
      ?? now.getTimezoneOffset(),
    snapshot_max_id: optionalInteger(query.get('snapshot_max_id')),
    device: query.get('device') || undefined,
    provider: query.get('provider') || undefined,
    model: query.get('model') || undefined,
    pricing_status: pricingStatus && PRICING_STATUSES.includes(pricingStatus)
      ? pricingStatus : undefined,
    source_marker: query.get('source_marker') || undefined,
    dedup_key: query.get('dedup_key') || undefined,
    project_group_id: optionalInteger(query.get('project_group_id')),
    session_id: query.get('session_id') || undefined,
    visibility: visibility && VISIBILITIES.includes(visibility)
      ? visibility : 'authoritative',
  }
}

export function withSnapshot(filters: AuditFilters, snapshot: QuerySnapshot): AuditFilters {
  return {
    ...filters, since: snapshot.since, until: snapshot.until,
    timezone_offset: snapshot.timezone_offset,
    snapshot_max_id: snapshot.max_record_id,
  }
}

export function auditSearchParams(
  filters: AuditFilters,
  cursor?: string | null,
): URLSearchParams {
  const params = new URLSearchParams({
    since: filters.since, until: filters.until,
    timezone_offset: String(filters.timezone_offset),
    visibility: filters.visibility,
  })
  if (filters.snapshot_max_id != null) {
    params.set('snapshot_max_id', String(filters.snapshot_max_id))
  }
  const optional: Array<[string, string | undefined]> = [
    ['device', filters.device], ['provider', filters.provider],
    ['model', filters.model], ['pricing_status', filters.pricing_status],
    ['source_marker', filters.source_marker], ['dedup_key', filters.dedup_key],
    ['session_id', filters.session_id],
  ]
  for (const [key, value] of optional) if (value) params.set(key, value)
  if (filters.project_group_id != null) {
    params.set('project_group_id', String(filters.project_group_id))
  }
  if (cursor) params.set('cursor', cursor)
  return params
}

export function auditSettingsHash(
  snapshot: QuerySnapshot,
  device: string,
  dimension: AuditDimension = {},
): string {
  const filters: AuditFilters = {
    since: dimension.since ?? snapshot.since,
    until: dimension.until ?? snapshot.until,
    timezone_offset: snapshot.timezone_offset,
    snapshot_max_id: snapshot.max_record_id,
    device: device === 'all' ? undefined : device,
    provider: dimension.provider,
    model: dimension.model,
    project_group_id: dimension.project_group_id,
    session_id: dimension.session_id,
    visibility: 'authoritative',
  }
  const params = auditSearchParams(filters)
  params.set('panel', 'audit')
  return `#/settings?${params.toString()}`
}
