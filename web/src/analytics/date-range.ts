import type { QuerySnapshot } from '@tokember/contracts/stats'

export type DashboardRange = 'today' | 7 | 30 | 0 | 'custom'
export type ComparisonMode =
  | 'none'
  | 'previous-period'
  | 'previous-week'
  | 'previous-month'
  | 'previous-year'
export type YearMetric = 'cost' | 'tokens' | 'calls'

export interface DashboardFilters {
  device: string
  project: string
  range: DashboardRange
  since?: string
  until?: string
  comparison: ComparisonMode
}

export interface SourceFilters extends DashboardFilters {
  provider: string
}

/** Public Dashboard keeps comparison analysis out of the primary view. */
export function publicDashboardFilters(filters: DashboardFilters): DashboardFilters {
  return filters.comparison === 'none'
    ? filters
    : { ...filters, comparison: 'none' }
}

export function sourceFiltersFromHash(hash: string): SourceFilters | null {
  const query = new URLSearchParams(hash.split('?')[1] ?? '')
  const provider = bounded(query.get('provider'))
  if (!provider) return null
  return { provider, ...publicDashboardFilters(dashboardFiltersFromHash(hash)) }
}

export function sourceHash(provider: string, filters: DashboardFilters): string {
  const query = new URLSearchParams(dashboardHash(publicDashboardFilters(filters)).split('?')[1] ?? '')
  query.set('provider', provider)
  return `#/source?${query}`
}

export interface YearFilters {
  year: number
  device: string
  metric: YearMetric
}

export interface ComparisonWindow {
  since: string
  until: string
  label: string
}

export interface NumericDelta {
  difference: number
  rate: number | null
  state: 'normal' | 'new' | 'zero'
}

const COMPARISONS: ComparisonMode[] = [
  'none', 'previous-period', 'previous-week', 'previous-month', 'previous-year',
]
const YEAR_METRICS: YearMetric[] = ['cost', 'tokens', 'calls']

function queryFromHash(hash: string): URLSearchParams {
  return new URLSearchParams(hash.split('?')[1] ?? '')
}

function bounded(value: string | null, max = 128): string | undefined {
  return value && value.trim() === value && value.length <= max ? value : undefined
}

function canonicalWindow(since: string | null, until: string | null) {
  if (!since || !until || !since.endsWith('Z') || !until.endsWith('Z')) return null
  const start = new Date(since)
  const end = new Date(until)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || start.toISOString() !== since || end.toISOString() !== until || start >= end) return null
  return { since, until }
}

function parseRange(value: string | null): DashboardRange {
  if (value === '7') return 7
  if (value === '30') return 30
  if (value === 'all') return 0
  if (value === 'custom') return 'custom'
  return 'today'
}

function parseProject(value: string | null): string {
  if (!value) return 'all'
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : 'all'
}

export function dashboardFiltersFromHash(hash: string): DashboardFilters {
  const query = queryFromHash(hash)
  const range = parseRange(query.get('range'))
  const device = bounded(query.get('device')) ?? 'all'
  const project = parseProject(bounded(query.get('project'), 32) ?? null)
  const comparison = query.get('compare') as ComparisonMode | null
  const window = range === 'custom'
    ? canonicalWindow(query.get('since'), query.get('until'))
    : null
  if (range === 'custom' && !window) {
    return { device, project, range: 'today', comparison: 'none' }
  }
  return {
    device, project, range,
    ...(window ?? {}),
    comparison: range === 0 || !comparison || !COMPARISONS.includes(comparison)
      ? 'none' : comparison,
  }
}

export function dashboardHash(filters: DashboardFilters): string {
  const range = filters.range === 0 ? 'all' : String(filters.range)
  const query = new URLSearchParams({ range })
  if (filters.device !== 'all') query.set('device', filters.device)
  if (filters.project !== 'all') query.set('project', filters.project)
  if (filters.comparison !== 'none' && filters.range !== 0) {
    query.set('compare', filters.comparison)
  }
  if (filters.range === 'custom' && filters.since && filters.until) {
    query.set('since', filters.since)
    query.set('until', filters.until)
  }
  return `#/?${query}`
}

export function yearFiltersFromHash(hash: string, now = new Date()): YearFilters {
  const query = queryFromHash(hash)
  const parsedYear = Number(query.get('year'))
  const metric = query.get('metric') as YearMetric | null
  return {
    year: Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 9999
      ? parsedYear : now.getFullYear(),
    device: bounded(query.get('device')) ?? 'all',
    metric: metric && YEAR_METRICS.includes(metric) ? metric : 'cost',
  }
}

export function yearHash(filters: YearFilters): string {
  const query = new URLSearchParams({ year: String(filters.year), metric: filters.metric })
  if (filters.device !== 'all') query.set('device', filters.device)
  return `#/year?${query}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function isoToLocalInput(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function localInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const fields = match.slice(1).map(Number)
  const date = new Date(fields[0], fields[1] - 1, fields[2], fields[3], fields[4])
  if (date.getFullYear() !== fields[0] || date.getMonth() !== fields[1] - 1
    || date.getDate() !== fields[2] || date.getHours() !== fields[3]
    || date.getMinutes() !== fields[4]) return null
  return date.toISOString()
}

export function currentLocalDayWindow(now = new Date()): { since: string; until: string } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return { since: start.toISOString(), until: now.toISOString() }
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function shiftMonth(date: Date, amount: number): Date {
  const shifted = new Date(date)
  const day = shifted.getDate()
  shifted.setDate(1)
  shifted.setMonth(shifted.getMonth() + amount)
  shifted.setDate(Math.min(day, daysInMonth(shifted.getFullYear(), shifted.getMonth())))
  return shifted
}

function shiftYear(date: Date, amount: number): Date {
  const shifted = new Date(date)
  const day = shifted.getDate()
  shifted.setDate(1)
  shifted.setFullYear(shifted.getFullYear() + amount)
  shifted.setDate(Math.min(day, daysInMonth(shifted.getFullYear(), shifted.getMonth())))
  return shifted
}

function shiftedWindow(
  snapshot: QuerySnapshot,
  shift: (value: Date) => Date,
  label: string,
): ComparisonWindow {
  return {
    since: shift(new Date(snapshot.since)).toISOString(),
    until: shift(new Date(snapshot.until)).toISOString(),
    label,
  }
}

export function comparisonWindow(
  snapshot: QuerySnapshot,
  mode: Exclude<ComparisonMode, 'none'>,
): ComparisonWindow {
  if (mode === 'previous-period') {
    const duration = Date.parse(snapshot.until) - Date.parse(snapshot.since)
    return {
      since: new Date(Date.parse(snapshot.since) - duration).toISOString(),
      until: snapshot.since, label: '上一周期',
    }
  }
  if (mode === 'previous-week') {
    return shiftedWindow(snapshot, value => {
      value.setDate(value.getDate() - 7); return value
    }, '上周同期')
  }
  if (mode === 'previous-month') {
    return shiftedWindow(snapshot, value => shiftMonth(value, -1), '上月同期')
  }
  return shiftedWindow(snapshot, value => shiftYear(value, -1), '去年同期')
}

export function numericDelta(current: number, previous: number): NumericDelta {
  const difference = current - previous
  if (previous === 0) {
    return current === 0
      ? { difference, rate: 0, state: 'zero' }
      : { difference, rate: null, state: 'new' }
  }
  return { difference, rate: difference / Math.abs(previous), state: 'normal' }
}
