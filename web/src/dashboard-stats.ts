import type { CostCoverage, QuerySnapshot, StatsResponse } from '@tokember/contracts/stats'
import type { ComparisonMode, DashboardFilters } from './analytics/date-range'
import { comparisonWindow, currentLocalDayWindow } from './analytics/date-range'
import { requestJson } from './data/api-client'
import {
  decodeDeviceOptions, decodeStatsResponse, type DeviceOption,
} from './data/public-decoders'

export interface StatsAggregateView {
  snapshot: QuerySnapshot
  total_cost: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_creation_tokens: number
  real_total_tokens: number
  total_requests: number
  pricing_coverage: CostCoverage
  daily: { date: string; since: string; until: string; cost: number; requests: number; input_tokens: number; output_tokens: number; real_total_tokens: number }[]
  by_provider: { provider: string; cost: number; requests: number; real_total_tokens: number }[]
  by_model: { model: string; provider: string; cost: number; requests: number; real_total_tokens: number; input_tokens: number; output_tokens: number; unpriced_requests: number }[]
  by_device: { device: string; provider: string; cost: number; requests: number; real_total_tokens: number }[]
  attribution: { status: string; records: number; cost: number; requests: number; real_total_tokens: number }[]
  project_options: { group_id: number; name: string; members: number }[]
  by_project: { group_id: number | null; name: string; members: number; cost: number; requests: number; real_total_tokens: number }[]
  by_session: { session_id: string; project_group_id: number | null; project_name: string | null; cost: number; requests: number; real_total_tokens: number }[]
}

export interface Stats extends StatsAggregateView {
  comparison: {
    mode: Exclude<ComparisonMode, 'none'>
    label: string
    stats: StatsAggregateView
  } | null
}

export interface DashboardRequest extends DashboardFilters {
  api: string
  provider?: string
}

function buildStatsParams(
  request: DashboardRequest,
  explicit?: { since: string; until: string; snapshotMaxId: number },
): URLSearchParams {
  const params = new URLSearchParams({
    timezone_offset: String(new Date().getTimezoneOffset()),
  })
  if (explicit) {
    params.set('since', explicit.since)
    params.set('until', explicit.until)
    params.set('snapshot_max_id', String(explicit.snapshotMaxId))
  } else if (request.range === 'custom' && request.since && request.until) {
    params.set('since', request.since)
    params.set('until', request.until)
  } else if (request.range === 'today') {
    const today = currentLocalDayWindow()
    params.set('range', 'today')
    params.set('since', today.since)
    params.set('until', today.until)
  } else {
    params.set('days', String(request.range))
  }
  if (request.device !== 'all') params.set('device_id', request.device)
  if (request.project !== 'all') params.set('project_group_id', request.project)
  if (request.provider) params.set('provider', request.provider)
  return params
}

function mapStats(data: StatsResponse): StatsAggregateView {
  return {
    snapshot: data.snapshot,
    total_cost: data.totals.total_cost,
    total_input_tokens: data.totals.total_input,
    total_output_tokens: data.totals.total_output,
    total_cache_read_tokens: data.totals.total_cache_read,
    total_cache_creation_tokens: data.totals.total_cache_creation,
    real_total_tokens: data.totals.real_total_tokens,
    total_requests: data.totals.total_calls,
    pricing_coverage: data.totals.pricing_coverage,
    daily: data.daily.map(row => ({
      date: row.date, since: row.since, until: row.until,
      cost: row.cost, requests: row.calls,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens,
      real_total_tokens: row.real_total_tokens,
    })),
    by_provider: data.byProvider.map(row => ({
      provider: row.provider, cost: row.cost, requests: row.calls,
      real_total_tokens: row.real_total_tokens,
    })),
    by_model: data.byModel.map(row => ({
      model: row.model, provider: row.provider, cost: row.cost, requests: row.calls,
      real_total_tokens: row.real_total_tokens,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens,
      unpriced_requests: row.pricing_coverage.unpriced_calls,
    })),
    by_device: data.byDevice.map(row => ({
      device: row.device, provider: row.provider, cost: row.cost,
      requests: row.calls, real_total_tokens: row.real_total_tokens,
    })),
    attribution: data.attribution.map(row => ({
      status: row.status, records: row.records, cost: row.cost,
      requests: row.calls, real_total_tokens: row.real_total_tokens,
    })),
    project_options: data.projectOptions.flatMap(row => row.group_id == null ? [] : [{
      group_id: row.group_id, name: row.name, members: row.members,
    }]),
    by_project: data.byProject.map(row => ({
      group_id: row.group_id, name: row.name, members: row.members,
      cost: row.cost, requests: row.calls, real_total_tokens: row.real_total_tokens,
    })),
    by_session: data.bySession.map(row => ({
      session_id: row.session_id, project_group_id: row.project_group_id,
      project_name: row.project_name, cost: row.cost, requests: row.calls,
      real_total_tokens: row.real_total_tokens,
    })),
  }
}

async function requestStats(
  request: DashboardRequest,
  signal: AbortSignal | undefined,
  explicit?: { since: string; until: string; snapshotMaxId: number },
): Promise<StatsAggregateView> {
  const params = buildStatsParams(request, explicit)
  const data = await requestJson(`${request.api}/api/stats?${params}`, {
    decode: decodeStatsResponse, signal, credentials: 'include',
  })
  return mapStats(data)
}

export async function fetchDashboardStats(
  request: DashboardRequest,
  signal?: AbortSignal,
): Promise<Stats> {
  const current = await requestStats(request, signal)
  if (request.comparison === 'none' || request.range === 0) {
    return { ...current, comparison: null }
  }
  const window = comparisonWindow(current.snapshot, request.comparison)
  const compared = await requestStats(request, signal, {
    since: window.since, until: window.until,
    snapshotMaxId: current.snapshot.max_record_id,
  })
  return {
    ...current,
    comparison: { mode: request.comparison, label: window.label, stats: compared },
  }
}

export function fetchDashboardDevices(api: string, signal?: AbortSignal): Promise<DeviceOption[]> {
  return requestJson(`${api}/api/devices`, {
    decode: decodeDeviceOptions, signal, credentials: 'include',
  })
}

export type { DeviceOption }
