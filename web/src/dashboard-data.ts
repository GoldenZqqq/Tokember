import {
  fetchDashboardDevices, fetchDashboardStats,
  type DashboardRequest, type DeviceOption, type Stats,
} from './dashboard-stats'

export interface DashboardTransport {
  stats: (request: DashboardRequest, signal: AbortSignal) => Promise<Stats>
  devices: (api: string, signal: AbortSignal) => Promise<DeviceOption[]>
}

const defaultTransport: DashboardTransport = {
  stats: fetchDashboardStats,
  devices: fetchDashboardDevices,
}

export const DASHBOARD_REVISIT_MAX_AGE_MS = 10_000

interface StatsCacheEntry {
  stats: Stats
  updatedAt: number
}

export function dashboardStatsKey(request: DashboardRequest): string {
  return JSON.stringify({
    api: request.api, device: request.device, project: request.project, range: request.range,
    since: request.since ?? null, until: request.until ?? null,
    comparison: request.comparison, provider: request.provider ?? null,
  })
}

export class DashboardRepository {
  private readonly statsCache = new Map<string, StatsCacheEntry>()
  private devicesCache: DeviceOption[] | null = null

  constructor(private readonly transport: DashboardTransport = defaultTransport) {}

  peekStats(request: DashboardRequest): Stats | null {
    return this.statsCache.get(dashboardStatsKey(request))?.stats ?? null
  }

  peekFreshStats(
    request: DashboardRequest,
    maxAgeMs: number,
    now = Date.now(),
  ): Stats | null {
    const entry = this.statsCache.get(dashboardStatsKey(request))
    if (!entry) return null
    const age = now - entry.updatedAt
    return age >= 0 && age <= maxAgeMs ? entry.stats : null
  }

  statsUpdatedAt(request: DashboardRequest): number | null {
    return this.statsCache.get(dashboardStatsKey(request))?.updatedAt ?? null
  }

  expireStats(request: DashboardRequest): void {
    const entry = this.statsCache.get(dashboardStatsKey(request))
    if (entry) entry.updatedAt = Number.NEGATIVE_INFINITY
  }

  peekDevices(): DeviceOption[] | null {
    return this.devicesCache
  }

  loadStats(request: DashboardRequest, signal: AbortSignal): Promise<Stats> {
    return this.transport.stats(request, signal)
  }

  commitStats(request: DashboardRequest, stats: Stats, updatedAt = Date.now()): void {
    this.statsCache.set(dashboardStatsKey(request), { stats, updatedAt })
  }

  loadDevices(api: string, signal: AbortSignal): Promise<DeviceOption[]> {
    return this.transport.devices(api, signal)
  }

  commitDevices(devices: DeviceOption[]): void {
    this.devicesCache = devices
  }

  async refreshStats(request: DashboardRequest, signal: AbortSignal): Promise<Stats> {
    const stats = await this.loadStats(request, signal)
    this.commitStats(request, stats)
    return stats
  }

  async refreshDevices(api: string, signal: AbortSignal): Promise<DeviceOption[]> {
    const devices = await this.loadDevices(api, signal)
    this.commitDevices(devices)
    return devices
  }

  async refreshAll(
    request: DashboardRequest,
    statsSignal: AbortSignal,
    devicesSignal: AbortSignal,
  ): Promise<[Stats, DeviceOption[]]> {
    return Promise.all([
      this.refreshStats(request, statsSignal),
      this.refreshDevices(request.api, devicesSignal),
    ])
  }
}
