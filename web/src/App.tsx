import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { DashboardHeader } from './components/DashboardHeader'
import { ResourceView } from './components/ResourceView'
import { ReadFeedback } from './components/ReadFeedback'
import type { RangeValue } from './components/RangeTabs'
import type { ResourceState } from './data/resource-state'
import type { DeviceOption, Stats } from './dashboard-stats'
import { useDashboardData } from './hooks/use-dashboard-data'
import { auditSettingsHash, type AuditDimension } from './audit/query'
import {
  currentLocalDayWindow,
  dashboardFiltersFromHash,
  dashboardHash,
  publicDashboardFilters,
  sourceFiltersFromHash,
  sourceHash,
  yearHash,
  type DashboardFilters,
} from './analytics/date-range'
import { AnalyticsControls } from './components/AnalyticsControls'
import { ViewerAccess } from './auth/ViewerAccess'
import { useViewerAccess } from './auth/use-viewer-access'
import { BurnHeatFrame } from './components/BurnHeatFrame'
import { FirstRunEmptyState } from './components/FirstRunEmptyState'
import { resolveBurnIntensity } from './burn/burn-intensity'
import {
  BURN_FX_CHANGE_EVENT,
  BURN_FX_STORAGE_KEY,
  readBurnPreference,
  type BurnPreference,
} from './burn/burn-preference'
import { useT } from './i18n'

const DashboardContent = lazy(() => import('./components/DashboardContent')
  .then(module => ({ default: module.DashboardContent })))
const SettingsPage = lazy(() => import('./components/settings/SettingsPage')
  .then(module => ({ default: module.SettingsPage })))
const YearPage = lazy(() => import('./components/year/YearPage')
  .then(module => ({ default: module.YearPage })))
const SourcePage = lazy(() => import('./components/source/SourcePage')
  .then(module => ({ default: module.SourcePage })))

const API = import.meta.env.VITE_API_URL || ''
const POLL_MS = 120_000

function useHashRoute(): string {
  const [route, setRoute] = useState(window.location.hash)
  useEffect(() => {
    const updateRoute = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', updateRoute)
    return () => window.removeEventListener('hashchange', updateRoute)
  }, [])
  return route
}

function useStatsPolling(loadStats: () => Promise<void>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (!timer) timer = setInterval(() => { loadStats() }, POLL_MS)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else { loadStats(); start() }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [enabled, loadStats])
}

interface DashboardProps {
  stats: ResourceState<Stats>
  devices: ResourceState<DeviceOption[]>
  filters: DashboardFilters
  onFiltersChange: (value: DashboardFilters) => void
  onRefresh: () => void
}

function isEmpty(stats: Stats | null): boolean {
  return stats != null && stats.by_model.length === 0 && stats.daily.length === 0
}

function filtersForRange(filters: DashboardFilters, range: RangeValue): DashboardFilters {
  const custom = range === 'custom' ? currentLocalDayWindow() : {}
  return {
    device: filters.device, project: filters.project, range, ...custom,
    comparison: range === 0 ? 'none' : filters.comparison,
  }
}

function DashboardControls(props: DashboardProps) {
  const refreshing = props.stats.status === 'refreshing' || props.devices.status === 'refreshing'
  return <>
    <DashboardHeader
      devices={props.devices.data ?? []}
      device={props.filters.device}
      range={props.filters.range}
      onDeviceChange={device => props.onFiltersChange({ ...props.filters, device })}
      onRangeChange={(range: RangeValue) => props.onFiltersChange(
        filtersForRange(props.filters, range),
      )}
      onSettings={() => { window.location.hash = '#/settings' }}
      onRefresh={props.onRefresh}
      refreshing={refreshing}
      onYear={() => { window.location.hash = yearHash({
        year: new Date().getFullYear(), device: props.filters.device, metric: 'cost',
      }) }}
    />
    <AnalyticsControls
      filters={props.filters}
      projects={props.stats.data?.project_options ?? []}
      onProject={project => props.onFiltersChange({ ...props.filters, project })}
      onCustomRange={(since, until) => props.onFiltersChange({
        ...props.filters, range: 'custom', since, until,
      })}
    />
  </>
}

function DeviceFeedback(props: DashboardProps) {
  const t = useT()
  if (props.devices.status !== 'error' && props.devices.status !== 'stale') return null
  return <div className="mb-4"><ReadFeedback loading={false}
    hasData={props.devices.data != null} error={props.devices.error}
    label={t('common.loadingDevices')} onRetry={props.onRefresh} /></div>
}

function DashboardResource(props: DashboardProps) {
  const t = useT()
  const current = props.stats.data
  const firstRun = current != null && isEmpty(current) && props.devices.data?.length === 0
  return <ResourceView status={props.stats.status} error={props.stats.error}
    empty={isEmpty(current) && !firstRun} loadingLabel={t('common.loadingUsage')}
    emptyLabel={t('common.emptyUsage')} onRetry={props.onRefresh}>
    {firstRun ? <FirstRunEmptyState /> : current ? <Suspense fallback={<RouteFallback />}><DashboardContent
      stats={current} range={props.filters.range}
      onAudit={(dimension?: AuditDimension) => {
        if (dimension?.provider && !dimension.model && !dimension.since && !dimension.until) {
          window.location.hash = sourceHash(dimension.provider, props.filters)
          return
        }
        window.location.hash = auditSettingsHash(
          current.snapshot, props.filters.device, dimension,
        )
      }}
    /></Suspense> : null}
  </ResourceView>
}

function Dashboard(props: DashboardProps) {
  useEffect(() => {
    if (props.devices.data && props.filters.device !== 'all'
      && !props.devices.data.some(device => device.id === props.filters.device)) {
      props.onFiltersChange({ ...props.filters, device: 'all' })
    }
  }, [props.devices.data, props.filters.device])
  useEffect(() => {
    const options = props.stats.data?.project_options
    if (options && props.filters.project !== 'all'
      && !options.some(project => String(project.group_id) === props.filters.project)) {
      props.onFiltersChange({ ...props.filters, project: 'all' })
    }
  }, [props.stats.data?.project_options, props.filters.project])
  return <div className="app-shell mx-auto min-h-screen max-w-7xl p-4 md:p-8">
    <DashboardControls {...props} />
    <DeviceFeedback {...props} />
    <DashboardResource {...props} />
  </div>
}

function RouteFallback() {
  const t = useT()
  return <div className="flex h-64 items-center justify-center text-sm text-zinc-500" role="status">{t('common.loadingPage')}</div>
}

function useBurnPreference(): BurnPreference {
  const [preference, setPreference] = useState<BurnPreference>(() => readBurnPreference())
  useEffect(() => {
    const sync = () => setPreference(readBurnPreference())
    const onStorage = (event: StorageEvent) => {
      if (event.key === BURN_FX_STORAGE_KEY || event.key == null) sync()
    }
    window.addEventListener(BURN_FX_CHANGE_EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(BURN_FX_CHANGE_EVENT, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return preference
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (!window.matchMedia) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function App() {
  const route = useHashRoute()
  const routePath = route.split('?')[0]
  const dashboardFilters = publicDashboardFilters(dashboardFiltersFromHash(route))
  const sourceFilters = sourceFiltersFromHash(route)
  const publicRoute = routePath !== '#/settings'
  const viewer = useViewerAccess(API, publicRoute)
  const viewerReady = viewer.state.status === 'authenticated'
  const dashboardVisible = viewerReady && routePath !== '#/settings' && routePath !== '#/year'
    && routePath !== '#/source'
  const yearVisible = viewerReady && routePath === '#/year'
  const sourceVisible = viewerReady && routePath === '#/source' && sourceFilters != null
  const data = useDashboardData(API, dashboardFilters, dashboardVisible,
    dashboardVisible || yearVisible || sourceVisible)
  useStatsPolling(data.refreshStats, dashboardVisible)
  const burnPreference = useBurnPreference()
  const reducedMotion = usePrefersReducedMotion()
  const burnIntensity = useMemo(() => resolveBurnIntensity({
    preference: burnPreference,
    reducedMotion,
    realTotalTokens: data.stats.data?.real_total_tokens ?? null,
    routeBlocksFx: routePath === '#/settings',
  }), [burnPreference, reducedMotion, data.stats.data?.real_total_tokens, routePath])
  const goHome = useCallback(() => { window.location.hash = '' }, [])
  const shell = 'app-shell mx-auto min-h-screen max-w-7xl p-4 md:p-8'
  const page = (() => {
    if (routePath === '#/settings') return <div className={shell}><Suspense fallback={<RouteFallback />}><SettingsPage onBack={goHome} /></Suspense></div>
    if (!viewerReady) return <div className={shell}><ViewerAccess
      state={viewer.state} onLogin={viewer.login} onRetry={() => { viewer.refresh() }}
      onSettings={() => { window.location.hash = '#/settings' }}
    /></div>
    if (routePath === '#/year') return <div className={shell}><Suspense fallback={<RouteFallback />}><YearPage
      onBack={goHome} devices={data.devices} onRefreshDevices={data.refreshDevices}
    /></Suspense></div>
    if (routePath === '#/source' && sourceFilters) return <div className={shell}><Suspense fallback={<RouteFallback />}><SourcePage
      api={API} filters={sourceFilters} devices={data.devices}
      onFiltersChange={filters => { window.location.hash = sourceHash(filters.provider, filters) }}
      onBack={goHome}
    /></Suspense></div>
    return <Dashboard
      stats={data.stats} devices={data.devices}
      filters={dashboardFilters}
      onFiltersChange={filters => { window.location.hash = dashboardHash(filters) }}
      onRefresh={() => { data.refreshAll() }}
    />
  })()
  return <>
    <BurnHeatFrame intensity={burnIntensity} />
    {page}
  </>
}

export default App
