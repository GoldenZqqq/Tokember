import {
  useCallback, useEffect, useRef, useState,
  type Dispatch, type RefObject, type SetStateAction,
} from 'react'
import type { AuditPublicRecord } from '@tokember/contracts/audit'
import type { AuditFilters } from '../audit/query'
import { isAbortError, toApiError, type ApiError } from '../data/api-client'
import { LatestRequest } from '../data/latest-request'
import {
  beginResource, failResource, initialResource, succeedResource,
  type ResourceState,
} from '../data/resource-state'
import { dashboardStatsKey } from '../dashboard-data'
import type { Stats } from '../dashboard-stats'
import {
  fetchSourceRecords, fetchSourceStats, type SourceRequest,
} from '../source-data'

export interface SourceData {
  stats: Stats
  records: AuditPublicRecord[]
  nextCursor: string | null
}

function auditFilters(request: SourceRequest, stats: Stats): AuditFilters {
  const project = Number(request.project)
  return {
    since: stats.snapshot.since,
    until: stats.snapshot.until,
    timezone_offset: stats.snapshot.timezone_offset,
    snapshot_max_id: stats.snapshot.max_record_id,
    device: request.device === 'all' ? undefined : request.device,
    provider: request.provider,
    project_group_id: Number.isSafeInteger(project) && project > 0 ? project : undefined,
    visibility: 'authoritative',
  }
}

async function loadSourceData(request: SourceRequest, signal: AbortSignal): Promise<SourceData> {
  const stats = await fetchSourceStats(request, signal)
  const page = await fetchSourceRecords({
    api: request.api,
    filters: auditFilters(request, stats),
  }, signal)
  return { stats, records: page.rows, nextCursor: page.next_cursor }
}

function useSourceResource(request: SourceRequest, latest: RefObject<LatestRequest>) {
  const [state, setState] = useState<ResourceState<SourceData>>(initialResource)
  const key = dashboardStatsKey(request)
  const refresh = useCallback(async () => {
    setState(current => beginResource(current, key))
    try {
      const result = await latest.current.execute(signal => loadSourceData(request, signal))
      if (result.current) {
        setState(current => succeedResource(current, key, result.value!))
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setState(current => failResource(current, key, toApiError(error)))
      }
    }
  }, [key])
  useEffect(() => {
    refresh()
    return () => latest.current.cancel()
  }, [refresh])
  return { state, setState, refresh }
}

function appendPage(
  current: ResourceState<SourceData>,
  page: Awaited<ReturnType<typeof fetchSourceRecords>>,
): ResourceState<SourceData> {
  return current.data == null ? current : {
    ...current,
    data: {
      ...current.data,
      records: [...current.data.records, ...page.rows],
      nextCursor: page.next_cursor,
    },
  }
}

function useSourcePagination(
  request: SourceRequest,
  latest: RefObject<LatestRequest>,
  state: ResourceState<SourceData>,
  setState: Dispatch<SetStateAction<ResourceState<SourceData>>>,
) {
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState<ApiError | null>(null)
  const loadMore = useCallback(async () => {
    const data = state.data
    if (!data?.nextCursor || loadingMore) return
    setLoadingMore(true)
    setPageError(null)
    try {
      const result = await latest.current.execute(signal => fetchSourceRecords({
        api: request.api,
        filters: auditFilters(request, data.stats),
        cursor: data.nextCursor,
      }, signal))
      if (result.current) {
        setState(current => appendPage(current, result.value!))
      }
    } catch (error) {
      if (!isAbortError(error)) setPageError(toApiError(error))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, request.api, state.data])
  const reset = useCallback(() => {
    setLoadingMore(false)
    setPageError(null)
  }, [])
  return { loadMore, loadingMore, pageError, reset }
}

export function useSourceData(request: SourceRequest) {
  const latest = useRef(new LatestRequest())
  const resource = useSourceResource(request, latest)
  const pagination = useSourcePagination(request, latest, resource.state, resource.setState)
  const refresh = useCallback(async () => {
    pagination.reset()
    await resource.refresh()
  }, [pagination.reset, resource.refresh])
  return { state: resource.state, refresh, ...pagination }
}
