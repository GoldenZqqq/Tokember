import { useCallback, useEffect, useRef, useState } from 'react'
import type { YearStatsResponse } from '@tokember/contracts/stats'
import { isAbortError, requestJson, toApiError } from './data/api-client'
import { LatestRequest } from './data/latest-request'
import { decodeYearStatsResponse } from './data/public-decoders'
import {
  beginResource, failResource, initialResource, succeedResource,
  type ResourceState,
} from './data/resource-state'

function yearKey(year: number, device: string): string {
  return `${device}:${year}`
}

export async function fetchYearStats(
  api: string,
  year: number,
  device: string,
  signal: AbortSignal,
): Promise<YearStatsResponse> {
  const params = new URLSearchParams({
    timezone_offset: String(new Date().getTimezoneOffset()),
    year: String(year),
    since: new Date(year, 0, 1).toISOString(),
    until: new Date(year + 1, 0, 1).toISOString(),
  })
  if (device !== 'all') params.set('device_id', device)
  return requestJson(`${api}/api/stats/year?${params}`, {
    decode: decodeYearStatsResponse, signal, credentials: 'include',
  })
}

export class YearRepository {
  private readonly cache = new Map<string, YearStatsResponse>()

  constructor(
    private readonly load: typeof fetchYearStats = fetchYearStats,
  ) {}

  peek(year: number, device: string): YearStatsResponse | null {
    return this.cache.get(yearKey(year, device)) ?? null
  }

  loadYear(
    api: string, year: number, device: string, signal: AbortSignal,
  ): Promise<YearStatsResponse> {
    return this.load(api, year, device, signal)
  }

  commit(year: number, device: string, value: YearStatsResponse): void {
    this.cache.set(yearKey(year, device), value)
  }

  async refresh(
    api: string, year: number, device: string, signal: AbortSignal,
  ): Promise<YearStatsResponse> {
    const value = await this.loadYear(api, year, device, signal)
    this.commit(year, device, value)
    return value
  }
}

const repository = new YearRepository()

function beginYear(
  state: ResourceState<YearStatsResponse>,
  year: number,
  device: string,
): ResourceState<YearStatsResponse> {
  const key = yearKey(year, device)
  if (state.key === key) return beginResource(state, key)
  const cached = repository.peek(year, device)
  const base = cached
    ? succeedResource(initialResource<YearStatsResponse>(), key, cached)
    : initialResource<YearStatsResponse>()
  return beginResource(base, key)
}

export function useYearData(api: string, year: number, device: string) {
  const request = useRef(new LatestRequest())
  const [state, setState] = useState<ResourceState<YearStatsResponse>>(initialResource)
  const key = yearKey(year, device)

  const refresh = useCallback(async () => {
    setState(current => beginYear(current, year, device))
    try {
      const result = await request.current.execute(
        signal => repository.loadYear(api, year, device, signal),
      )
      if (result.current) {
        repository.commit(year, device, result.value!)
        setState(current => succeedResource(current, key, result.value!))
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setState(current => failResource(current, key, toApiError(error)))
      }
    }
  }, [api, device, key, year])

  useEffect(() => {
    refresh()
    return () => request.current.cancel()
  }, [refresh])

  return { state, refresh }
}
