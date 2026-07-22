import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError, toApiError } from '../data/api-client'
import { LatestRequest } from '../data/latest-request'
import {
  beginResource, failResource, initialResource, succeedResource,
  type ResourceState,
} from '../data/resource-state'
import {
  DASHBOARD_REVISIT_MAX_AGE_MS,
  DashboardRepository,
  dashboardStatsKey,
} from '../dashboard-data'
import type { DashboardRequest, DeviceOption, Stats } from '../dashboard-stats'
import type { DashboardFilters } from '../analytics/date-range'

const repository = new DashboardRepository()
const DEVICES_KEY = 'devices'

function beginCached<T>(
  state: ResourceState<T>,
  key: string,
  cached: T | null,
): ResourceState<T> {
  if (state.key === key) return beginResource(state, key)
  const base = cached == null
    ? initialResource<T>()
    : succeedResource(initialResource<T>(), key, cached)
  return beginResource(base, key)
}

function useStatsResource(request: DashboardRequest, enabled: boolean) {
  const latest = useRef(new LatestRequest())
  const [state, setState] = useState<ResourceState<Stats>>(initialResource)
  const key = dashboardStatsKey(request)
  const refresh = useCallback(async () => {
    setState(current => beginCached(current, key, repository.peekStats(request)))
    try {
      const result = await latest.current.execute(signal => repository.loadStats(request, signal))
      if (result.current) {
        repository.commitStats(request, result.value!)
        setState(current => succeedResource(current, key, result.value!))
      }
    } catch (error) {
      if (!isAbortError(error)) {
        repository.expireStats(request)
        setState(current => failResource(current, key, toApiError(error)))
      }
    }
  }, [key, request.api, request.device, request.project, request.range])
  const select = useCallback(() => {
    const cached = repository.peekFreshStats(request, DASHBOARD_REVISIT_MAX_AGE_MS)
    if (!cached) {
      refresh()
      return
    }
    latest.current.cancel()
    setState(current => succeedResource(
      current,
      key,
      cached,
      repository.statsUpdatedAt(request) ?? Date.now(),
    ))
  }, [key, refresh])
  useEffect(() => {
    if (!enabled) return
    select()
    return () => latest.current.cancel()
  }, [enabled, select])
  return { state, refresh }
}

function useDevicesResource(api: string, enabled: boolean) {
  const latest = useRef(new LatestRequest())
  const [state, setState] = useState<ResourceState<DeviceOption[]>>(initialResource)
  const refresh = useCallback(async () => {
    setState(current => beginCached(current, DEVICES_KEY, repository.peekDevices()))
    try {
      const result = await latest.current.execute(signal => repository.loadDevices(api, signal))
      if (result.current) {
        repository.commitDevices(result.value!)
        setState(current => succeedResource(current, DEVICES_KEY, result.value!))
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setState(current => failResource(current, DEVICES_KEY, toApiError(error)))
      }
    }
  }, [api])
  useEffect(() => {
    if (!enabled) return
    refresh()
    return () => latest.current.cancel()
  }, [enabled, refresh])
  return { state, refresh }
}

export function useDashboardData(
  api: string,
  filters: DashboardFilters,
  statsEnabled: boolean,
  devicesEnabled = statsEnabled,
) {
  const stats = useStatsResource({ api, ...filters }, statsEnabled)
  const devices = useDevicesResource(api, devicesEnabled)
  const refreshAll = useCallback(async () => {
    await Promise.all([stats.refresh(), devices.refresh()])
  }, [devices.refresh, stats.refresh])
  return {
    stats: stats.state,
    devices: devices.state,
    refreshStats: stats.refresh,
    refreshDevices: devices.refresh,
    refreshAll,
  }
}
