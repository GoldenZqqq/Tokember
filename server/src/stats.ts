import type {
  AttributionDisplayStatus,
  AttributionStatusRow,
  CostCoverage,
  DeviceStatsRow,
  ModelStatsRow,
  MonthStatsRow,
  ProviderStatsRow,
  ProjectStatsRow,
  QuerySnapshot,
  StatsAggregateRow,
  StatsResponse,
  StatsTotals,
  SessionStatsRow,
  TrendStatsRow,
  YearStatsResponse,
  YearStatsRow,
} from '@tokember/contracts/stats'
import type { DB } from './db.js'
import { buildAuthoritativeSourceFilter } from './source-authority.js'
import {
  buildCostCoverage,
  INCOMPLETE_PRICING_STATUSES,
  realTotalTokensSql,
} from './usage-metrics.js'

const MIN_TIMEZONE_OFFSET = -14 * 60
const MAX_TIMEZONE_OFFSET = 14 * 60
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const INCOMPLETE_PRICING_SQL = INCOMPLETE_PRICING_STATUSES
  .map(status => `'${status}'`)
  .join(', ')

export interface StatsQuery {
  days?: string
  range?: string
  since?: string
  until?: string
  snapshot_max_id?: string
  timezone_offset?: string
  device_id?: string
  provider?: string
  project_group_id?: string
  year?: string
}

interface UsageFilter {
  sql: string
  params: Array<string | number>
}

interface AggregateRow {
  calls: number | null
  real_total_tokens: number | null
  cost: number | null
  unpriced_calls: number | null
  unpriced_tokens: number | null
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseTimezoneOffset(value: string | undefined): number {
  const offset = Number(value)
  if (!Number.isFinite(offset)) return 0
  return Math.max(MIN_TIMEZONE_OFFSET, Math.min(MAX_TIMEZONE_OFFSET, offset))
}

function timezoneModifier(offset: number): string {
  const localMinutes = -offset
  return `${localMinutes >= 0 ? '+' : ''}${localMinutes} minutes`
}

function getLocalDayStart(now: Date, offset: number): string {
  const localNow = new Date(now.getTime() - offset * 60_000)
  localNow.setUTCHours(0, 0, 0, 0)
  return new Date(localNow.getTime() + offset * 60_000).toISOString()
}

function buildUsageFilter(
  since: string,
  until: string,
  maxRecordId: number,
  deviceId?: string,
  alias = '',
  projectGroupId?: number | null,
  provider?: string,
): UsageFilter {
  const prefix = alias ? `${alias}.` : 'usage_records.'
  const conditions = [
    `${prefix}timestamp >= ?`,
    `${prefix}timestamp < ?`,
    `${prefix}id <= ?`,
    buildAuthoritativeSourceFilter(alias, maxRecordId),
  ]
  const params: Array<string | number> = [since, until, maxRecordId]
  if (deviceId) {
    conditions.push(`${prefix}device_id = ?`)
    params.push(deviceId)
  }
  if (provider) {
    conditions.push(`${prefix}provider = ?`)
    params.push(provider)
  }
  if (projectGroupId != null) {
    conditions.push(`EXISTS (
      SELECT 1 FROM attribution_projects attribution_project
      WHERE attribution_project.device_id = ${prefix}device_id
        AND attribution_project.project_id = ${prefix}project_id
        AND attribution_project.group_id = ?
    )`)
    params.push(projectGroupId)
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params }
}

function aggregateSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  const total = realTotalTokensSql(alias)
  const incomplete = `${prefix}pricing_status IN (${INCOMPLETE_PRICING_SQL})`
  return `
    SUM(${prefix}request_count) AS calls,
    SUM(${total}) AS real_total_tokens,
    SUM(${prefix}cost_usd) AS cost,
    SUM(CASE WHEN ${incomplete} THEN ${prefix}request_count ELSE 0 END) AS unpriced_calls,
    SUM(CASE WHEN ${incomplete} THEN ${total} ELSE 0 END) AS unpriced_tokens
  `
}

function normalizeAggregate(row?: Partial<AggregateRow>): StatsAggregateRow {
  const calls = number(row?.calls)
  const tokens = number(row?.real_total_tokens)
  const unpricedCalls = number(row?.unpriced_calls)
  const unpricedTokens = number(row?.unpriced_tokens)
  return {
    calls,
    real_total_tokens: tokens,
    cost: number(row?.cost),
    pricing_coverage: buildCostCoverage(calls, tokens, unpricedCalls, unpricedTokens),
  }
}

function explicitStatsWindow(query: StatsQuery): { since: string; until: string } | null {
  if (!query.since || !query.until) return null
  const since = new Date(query.since)
  const until = new Date(query.until)
  if (!query.since.endsWith('Z') || !query.until.endsWith('Z')
    || !Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime())
    || since.toISOString() !== query.since || until.toISOString() !== query.until
    || since >= until) return null
  return { since: query.since, until: query.until }
}

function getStatsWindow(query: StatsQuery, now: Date): { since: string; until: string } {
  const explicit = explicitStatsWindow(query)
  if (explicit) return explicit
  const parsedDays = query.days == null || query.days === '' ? 30 : Number(query.days)
  const days = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 30
  const offset = parseTimezoneOffset(query.timezone_offset)
  const since = query.range === 'today'
    ? getLocalDayStart(now, offset)
    : days === 0
      ? '1970-01-01T00:00:00.000Z'
      : new Date(now.getTime() - days * DAY_MS).toISOString()
  return { since, until: now.toISOString() }
}

function getTotals(db: DB, filter: UsageFilter): StatsTotals {
  const row = db.prepare(`
    SELECT
      SUM(input_tokens) AS total_input,
      SUM(output_tokens) AS total_output,
      SUM(cache_read_tokens) AS total_cache_read,
      SUM(cache_creation_tokens) AS total_cache_creation,
      ${aggregateSql()}
    FROM usage_records ${filter.sql}
  `).get(...filter.params) as AggregateRow & Record<string, number | null>
  const aggregate = normalizeAggregate(row)
  return {
    total_calls: aggregate.calls,
    total_input: number(row.total_input),
    total_output: number(row.total_output),
    total_cache_read: number(row.total_cache_read),
    total_cache_creation: number(row.total_cache_creation),
    real_total_tokens: aggregate.real_total_tokens,
    total_cost: aggregate.cost,
    pricing_coverage: aggregate.pricing_coverage,
  }
}

function getProviderStats(db: DB, filter: UsageFilter): ProviderStatsRow[] {
  const rows = db.prepare(`
    SELECT provider, ${aggregateSql()}
    FROM usage_records ${filter.sql}
    GROUP BY provider ORDER BY cost DESC
  `).all(...filter.params) as Array<AggregateRow & { provider: string }>
  return rows.map(row => {
    const aggregate = normalizeAggregate(row)
    return {
      provider: row.provider,
      tokens: aggregate.real_total_tokens,
      ...aggregate,
    }
  })
}

function getModelStats(db: DB, filter: UsageFilter): ModelStatsRow[] {
  const rows = db.prepare(`
    SELECT model, provider,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      ${aggregateSql()}
    FROM usage_records ${filter.sql}
    GROUP BY model, provider ORDER BY cost DESC
  `).all(...filter.params) as Array<AggregateRow & Record<string, string | number>>
  return rows.map(row => {
    const aggregate = normalizeAggregate(row)
    return {
      model: String(row.model),
      provider: String(row.provider),
      tokens: aggregate.real_total_tokens,
      input_tokens: number(row.input_tokens),
      output_tokens: number(row.output_tokens),
      unpriced_calls: aggregate.pricing_coverage.unpriced_calls,
      ...aggregate,
    }
  })
}

function getDeviceStats(db: DB, filter: UsageFilter): DeviceStatsRow[] {
  const rows = db.prepare(`
    SELECT d.name AS device, u.provider, ${aggregateSql('u')}
    FROM usage_records u JOIN devices d ON u.device_id = d.id
    ${filter.sql}
    GROUP BY d.name, u.provider ORDER BY cost DESC
  `).all(...filter.params) as Array<AggregateRow & { device: string; provider: string }>
  return rows.map(row => ({
    device: row.device,
    provider: row.provider,
    ...normalizeAggregate(row),
  }))
}

function getAttributionStats(db: DB, filter: UsageFilter): AttributionStatusRow[] {
  const rows = db.prepare(`
    SELECT COALESCE(attribution_status, 'unknown') AS status,
      COUNT(*) AS records, ${aggregateSql()}
    FROM usage_records ${filter.sql}
    GROUP BY COALESCE(attribution_status, 'unknown')
  `).all(...filter.params) as Array<AggregateRow & {
    status: AttributionDisplayStatus
    records: number
  }>
  const byStatus = new Map(rows.map(row => [row.status, row]))
  return (['captured', 'disabled', 'unsupported', 'unknown'] as const).map(status => {
    const row = byStatus.get(status)
    return { status, records: number(row?.records), ...normalizeAggregate(row) }
  })
}

function projectName(groupId: number, displayName: string | null): string {
  return displayName || `项目 ${groupId}`
}

function getProjectStats(db: DB, filter: UsageFilter): ProjectStatsRow[] {
  const rows = db.prepare(`
    SELECT p.group_id, g.display_name,
      COUNT(DISTINCT p.device_id || char(0) || p.project_id) AS members,
      ${aggregateSql('u')}
    FROM usage_records u
    JOIN attribution_projects p
      ON p.device_id = u.device_id AND p.project_id = u.project_id
    JOIN attribution_project_groups g ON g.id = p.group_id
    ${filter.sql} AND u.attribution_status = 'captured'
    GROUP BY p.group_id, g.display_name
    ORDER BY cost DESC, p.group_id
  `).all(...filter.params) as Array<AggregateRow & {
    group_id: number
    display_name: string | null
    members: number
  }>
  return rows.map(row => ({
    group_id: row.group_id,
    name: projectName(row.group_id, row.display_name),
    members: number(row.members),
    ...normalizeAggregate(row),
  }))
}

function getSessionStats(db: DB, filter: UsageFilter): SessionStatsRow[] {
  const rows = db.prepare(`
    SELECT u.session_id, p.group_id AS project_group_id,
      g.display_name AS project_name, ${aggregateSql('u')}
    FROM usage_records u
    LEFT JOIN attribution_projects p
      ON p.device_id = u.device_id AND p.project_id = u.project_id
    LEFT JOIN attribution_project_groups g ON g.id = p.group_id
    ${filter.sql} AND u.attribution_status = 'captured' AND u.session_id IS NOT NULL
    GROUP BY u.session_id, p.group_id, g.display_name
    ORDER BY cost DESC, u.session_id
    LIMIT 50
  `).all(...filter.params) as Array<AggregateRow & {
    session_id: string
    project_group_id: number | null
    project_name: string | null
  }>
  return rows.map(row => ({
    session_id: row.session_id,
    project_group_id: row.project_group_id,
    project_name: row.project_group_id == null
      ? null : projectName(row.project_group_id, row.project_name),
    ...normalizeAggregate(row),
  }))
}

function trendRow(
  row: Partial<AggregateRow> & Record<string, unknown>,
  date: string,
  since: string,
  until: string,
): TrendStatsRow {
  const aggregate = normalizeAggregate(row)
  return {
    date,
    since,
    until,
    tokens: aggregate.real_total_tokens,
    input_tokens: number(row.input_tokens),
    output_tokens: number(row.output_tokens),
    ...aggregate,
  }
}

function getTodayTrend(
  db: DB,
  filter: UsageFilter,
  modifier: string,
  snapshot: QuerySnapshot,
): TrendStatsRow[] {
  const rows = db.prepare(`
    SELECT strftime('%H', timestamp, ?) AS hour,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      ${aggregateSql()}
    FROM usage_records ${filter.sql}
    GROUP BY strftime('%H', timestamp, ?)
  `).all(modifier, ...filter.params, modifier) as Array<AggregateRow & Record<string, unknown>>
  const byHour = new Map(rows.map(row => [String(row.hour), row]))
  return Array.from({ length: 24 }, (_, hour) => {
    const key = String(hour).padStart(2, '0')
    const bucketStart = new Date(Date.parse(snapshot.since) + hour * HOUR_MS)
    const bucketEnd = new Date(bucketStart.getTime() + HOUR_MS)
    const since = bucketStart >= new Date(snapshot.until)
      ? snapshot.until
      : bucketStart.toISOString()
    const until = bucketEnd >= new Date(snapshot.until)
      ? snapshot.until
      : bucketEnd.toISOString()
    return trendRow(byHour.get(key) ?? {}, `${key}:00`, since, until)
  })
}

function localToUtc(value: string, offset: number): string {
  return new Date(Date.parse(`${value}Z`) + offset * 60_000).toISOString()
}

function boundedWindow(
  since: string,
  until: string,
  snapshot: QuerySnapshot,
): Pick<QuerySnapshot, 'since' | 'until'> {
  const boundedSince = since < snapshot.since ? snapshot.since : since
  const boundedUntil = until > snapshot.until ? snapshot.until : until
  return boundedSince > boundedUntil
    ? { since: boundedUntil, until: boundedUntil }
    : { since: boundedSince, until: boundedUntil }
}

function localDayWindow(
  date: string,
  offset: number,
  snapshot: QuerySnapshot,
): Pick<QuerySnapshot, 'since' | 'until'> {
  const start = localToUtc(`${date}T00:00:00.000`, offset)
  const end = new Date(Date.parse(start) + DAY_MS).toISOString()
  return boundedWindow(start, end, snapshot)
}

function getDailyTrend(
  db: DB,
  filter: UsageFilter,
  modifier: string,
  snapshot: QuerySnapshot,
): TrendStatsRow[] {
  const rows = db.prepare(`
    SELECT date(timestamp, ?) AS date,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      ${aggregateSql()}
    FROM usage_records ${filter.sql}
    GROUP BY date(timestamp, ?) ORDER BY date
  `).all(modifier, ...filter.params, modifier) as Array<AggregateRow & Record<string, unknown>>
  return rows.map(row => {
    const date = String(row.date)
    const window = localDayWindow(date, snapshot.timezone_offset, snapshot)
    return trendRow(row, date, window.since, window.until)
  })
}

function getMaxRecordId(db: DB): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM usage_records').get() as { id: number | null }
  return number(row.id)
}

function getSnapshotMaxRecordId(db: DB, requested: string | undefined): number {
  const current = getMaxRecordId(db)
  if (requested == null || requested === '') return current
  const parsed = Number(requested)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= current ? parsed : current
}

export function getStatsResponse(
  db: DB,
  query: StatsQuery,
  now = new Date(),
): StatsResponse {
  const offset = parseTimezoneOffset(query.timezone_offset)
  const window = getStatsWindow(query, now)
  const snapshot = {
    ...window, timezone_offset: offset,
    max_record_id: getSnapshotMaxRecordId(db, query.snapshot_max_id),
  }
  const parsedProject = Number(query.project_group_id)
  const projectGroupId = Number.isSafeInteger(parsedProject) && parsedProject > 0
    ? parsedProject : null
  const baseFilter = buildUsageFilter(
    snapshot.since, snapshot.until, snapshot.max_record_id, query.device_id,
    '', undefined, query.provider,
  )
  const baseJoinedFilter = buildUsageFilter(
    snapshot.since, snapshot.until, snapshot.max_record_id, query.device_id, 'u',
    undefined, query.provider,
  )
  const filter = buildUsageFilter(
    snapshot.since, snapshot.until, snapshot.max_record_id, query.device_id,
    '', projectGroupId, query.provider,
  )
  const joinedFilter = buildUsageFilter(
    snapshot.since, snapshot.until, snapshot.max_record_id, query.device_id, 'u',
    projectGroupId, query.provider,
  )
  const modifier = timezoneModifier(offset)
  return {
    snapshot,
    totals: getTotals(db, filter),
    byProvider: getProviderStats(db, filter),
    byModel: getModelStats(db, filter),
    byDevice: getDeviceStats(db, joinedFilter),
    attribution: getAttributionStats(db, filter),
    projectOptions: getProjectStats(db, baseJoinedFilter),
    byProject: getProjectStats(db, joinedFilter),
    bySession: getSessionStats(db, joinedFilter),
    daily: query.range === 'today'
      ? getTodayTrend(db, filter, modifier, snapshot)
      : getDailyTrend(db, filter, modifier, snapshot),
  }
}

function localYearWindow(year: number, offset: number): { since: string; until: string } {
  return {
    since: localToUtc(`${year}-01-01T00:00:00.000`, offset),
    until: localToUtc(`${year + 1}-01-01T00:00:00.000`, offset),
  }
}

function getYearRows<T extends 'date' | 'month'>(
  db: DB,
  filter: UsageFilter,
  modifier: string,
  field: T,
): Array<AggregateRow & Record<T, string>> {
  const expression = field === 'date'
    ? 'date(timestamp, ?)'
    : "strftime('%m', timestamp, ?)"
  return db.prepare(`
    SELECT ${expression} AS ${field}, ${aggregateSql()}
    FROM usage_records ${filter.sql}
    GROUP BY ${expression} ORDER BY ${field}
  `).all(modifier, ...filter.params, modifier) as Array<AggregateRow & Record<T, string>>
}

function yearRow(
  row: AggregateRow,
  date: string,
  snapshot: QuerySnapshot,
): YearStatsRow {
  const window = localDayWindow(date, snapshot.timezone_offset, snapshot)
  return { date, ...window, ...normalizeAggregate(row) }
}

function summarizeYear(rows: YearStatsRow[]): StatsAggregateRow {
  const totals = rows.reduce((sum, row) => ({
    calls: sum.calls + row.calls,
    real_total_tokens: sum.real_total_tokens + row.real_total_tokens,
    cost: sum.cost + row.cost,
    unpriced_calls: sum.unpriced_calls + row.pricing_coverage.unpriced_calls,
    unpriced_tokens: sum.unpriced_tokens + row.pricing_coverage.unpriced_tokens,
  }), { calls: 0, real_total_tokens: 0, cost: 0, unpriced_calls: 0, unpriced_tokens: 0 })
  return normalizeAggregate(totals)
}

function buildMonths(
  year: number,
  rows: Array<AggregateRow & { month: string }>,
  snapshot: QuerySnapshot,
): MonthStatsRow[] {
  const byMonth = new Map(rows.map(row => [row.month, row]))
  return Array.from({ length: 12 }, (_, index) => {
    const key = String(index + 1).padStart(2, '0')
    const month = `${year}-${key}`
    const next = index === 11 ? `${year + 1}-01` : `${year}-${String(index + 2).padStart(2, '0')}`
    const window = boundedWindow(
      localToUtc(`${month}-01T00:00:00.000`, snapshot.timezone_offset),
      localToUtc(`${next}-01T00:00:00.000`, snapshot.timezone_offset),
      snapshot,
    )
    return { month, ...window, ...normalizeAggregate(byMonth.get(key)) }
  })
}

function getAvailableYears(
  db: DB,
  maxRecordId: number,
  modifier: string,
  deviceId?: string,
): number[] {
  const conditions = [
    'u.id <= ?', buildAuthoritativeSourceFilter('u', maxRecordId),
  ]
  const params: Array<string | number> = [modifier, maxRecordId]
  if (deviceId) { conditions.push('u.device_id = ?'); params.push(deviceId) }
  const rows = db.prepare(`
    SELECT DISTINCT strftime('%Y', u.timestamp, ?) AS year
    FROM usage_records u WHERE ${conditions.join(' AND ')}
    ORDER BY year DESC
  `).all(...params) as Array<{ year: string | null }>
  return rows.map(row => Number(row.year)).filter(Number.isInteger)
}

export function getYearStatsResponse(
  db: DB,
  query: StatsQuery,
  now = new Date(),
): YearStatsResponse {
  const parsedYear = Number(query.year)
  const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 9999
    ? parsedYear
    : now.getFullYear()
  const offset = parseTimezoneOffset(query.timezone_offset)
  const window = explicitStatsWindow(query) ?? localYearWindow(year, offset)
  const snapshot = {
    ...window, timezone_offset: offset,
    max_record_id: getSnapshotMaxRecordId(db, query.snapshot_max_id),
  }
  const filter = buildUsageFilter(
    snapshot.since, snapshot.until, snapshot.max_record_id, query.device_id,
    '', undefined, query.provider,
  )
  const modifier = timezoneModifier(offset)
  const daily = getYearRows(db, filter, modifier, 'date')
    .map(row => yearRow(row, row.date, snapshot))
  const monthly = buildMonths(
    year, getYearRows(db, filter, modifier, 'month'), snapshot,
  )
  const summary = summarizeYear(daily)
  const peak = daily.reduce(
    (best, row) => row.cost > best.cost ? { date: row.date, cost: row.cost } : best,
    { date: '', cost: 0 },
  )
  return {
    year,
    available_years: getAvailableYears(
      db, snapshot.max_record_id, modifier, query.device_id,
    ),
    snapshot,
    totals: {
      total_cost: summary.cost,
      total_calls: summary.calls,
      real_total_tokens: summary.real_total_tokens,
      active_days: daily.length,
      pricing_coverage: summary.pricing_coverage,
    },
    peak,
    daily,
    monthly,
  }
}
