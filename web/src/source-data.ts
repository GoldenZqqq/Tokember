import type { AuditPublicRecord, AuditRecordsPage } from '@tokember/contracts/audit'
import type { AuditFilters } from './audit/query'
import { auditSearchParams } from './audit/query'
import { decodePublicAuditRecords } from './audit/decoders'
import { fetchDashboardStats, type DashboardRequest, type Stats } from './dashboard-stats'
import { requestJson } from './data/api-client'

export interface SourceRequest extends DashboardRequest {
  provider: string
}

export interface SourceRecordsRequest {
  api: string
  filters: AuditFilters
  cursor?: string | null
}

export function fetchSourceStats(
  request: SourceRequest,
  signal?: AbortSignal,
): Promise<Stats> {
  return fetchDashboardStats(request, signal)
}

export function fetchSourceRecords(
  request: SourceRecordsRequest,
  signal?: AbortSignal,
): Promise<AuditRecordsPage<AuditPublicRecord>> {
  const params = auditSearchParams(request.filters, request.cursor)
  params.delete('visibility')
  params.set('limit', '50')
  return requestJson(`${request.api}/api/records?${params}`, {
    decode: decodePublicAuditRecords,
    signal,
    credentials: 'include',
  })
}
