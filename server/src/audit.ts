import { createHash } from 'node:crypto'
import type {
  AuditAdminRecord,
  AuditCutoverPage,
  AuditMetricSummary,
  AuditPublicRecord,
  AuditReconciliationResponse,
  AuditRecordsPage,
  AuditSummaryResponse,
  AuditVisibility,
  PricingStatus,
} from '@tokember/contracts/audit'
import type { AttributionDisplayStatus, QuerySnapshot } from '@tokember/contracts/stats'
import type { DB } from './db.js'
import { getCollectorTelemetryCoverage } from './collector-retention.js'
import {
  listPricingRules,
  type PricingRuleWithAliases,
} from './pricing.js'
import { pricingExplanation } from './audit-pricing.js'
import { buildAuthoritativeSourceFilter } from './source-authority.js'
import {
  billableOutputTokensSql,
  buildCostCoverage,
  freshInputTokensSql,
  INCOMPLETE_PRICING_STATUSES,
  realTotalTokensSql,
} from './usage-metrics.js'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 100
const MAX_TEXT = 500
const EPOCH = '1970-01-01T00:00:00.000Z'
const AUDIT_VISIBILITIES: readonly AuditVisibility[] = ['authoritative', 'physical', 'hidden']
const PRICING_STATUSES: readonly PricingStatus[] = [
  'provided', 'priced', 'free', 'included', 'unpriced', 'none', 'ignored',
]
const INCOMPLETE_SQL = INCOMPLETE_PRICING_STATUSES.map(value => `'${value}'`).join(', ')

type RawQuery = Record<string, string>
interface AuditCursor {
  version: 1
  timestamp: string
  id: number
  snapshot_max_id: number
  filter_hash: string
}

export interface AuditQuery {
  snapshot: QuerySnapshot
  visibility: AuditVisibility
  device: string | null
  provider: string | null
  model: string | null
  pricing_status: PricingStatus | null
  source_marker: string | null
  dedup_key: string | null
  project_group_id: number | null
  session_id: string | null
  limit: number
  cursor: AuditCursor | null
  filter_hash: string
}

interface QueryOptions {
  admin: boolean
  pagination?: boolean
  now?: Date
}

interface UsageRow extends Record<string, unknown> {
  id: number
  device_id: string
  device_name: string
  provider: string
  model: string
  timestamp: string
  pricing_status: PricingStatus
  pricing_rule_id: number | null
  cost_usd: number
  attribution_version: number | null
  attribution_status: string | null
  project_id: string | null
  session_id: string | null
  project_group_id: number | null
  project_name: string | null
}

interface SqlFilter {
  sql: string
  params: Array<string | number>
}

export class AuditRequestError extends Error {
  constructor(public readonly field: string, public readonly code = 'invalid_query') {
    super(`Invalid audit query field: ${field}`)
  }

  toResponse(): { error: string; code: string; field: string } {
    return { error: 'invalid audit query', code: this.code, field: this.field }
  }
}

function currentMaxRecordId(db: DB): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM usage_records').get() as { id: number | null }
  return Math.max(0, Number(row.id) || 0)
}

function parseIso(value: string | undefined, fallback: string, field: string): string {
  if (value == null || value === '') return fallback
  const date = new Date(value)
  if (!value.endsWith('Z') || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new AuditRequestError(field)
  }
  return value
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AuditRequestError(field)
  }
  return parsed
}

function boundedText(value: string | undefined, field: string): string | null {
  if (value == null || value === '') return null
  if (value.trim() !== value || value.length > MAX_TEXT) throw new AuditRequestError(field)
  return value
}

function optionalPositiveInteger(value: string | undefined, field: string): number | null {
  if (value == null || value === '') return null
  return parseInteger(value, 0, field, 1, Number.MAX_SAFE_INTEGER)
}

function decodeCursor(value: string | undefined): AuditCursor | null {
  if (!value) return null
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as AuditCursor
    if (decoded.version !== 1 || !Number.isInteger(decoded.id) || decoded.id <= 0
      || !Number.isInteger(decoded.snapshot_max_id) || decoded.snapshot_max_id < 0
      || typeof decoded.filter_hash !== 'string' || typeof decoded.timestamp !== 'string'
      || !decoded.timestamp || decoded.timestamp.length > 80) throw new Error('shape')
    return decoded
  } catch {
    throw new AuditRequestError('cursor', 'invalid_cursor')
  }
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function assertAllowed(raw: RawQuery, options: QueryOptions): void {
  const common = [
    'since', 'until', 'snapshot_max_id', 'timezone_offset', 'device',
    'device_id', 'provider', 'model', 'pricing_status',
    'project_group_id', 'session_id',
  ]
  const admin = ['source_marker', 'dedup_key', 'visibility']
  const pagination = ['limit', 'cursor']
  const allowed = new Set([
    ...common,
    ...(options.admin ? admin : []),
    ...(options.pagination === false ? [] : pagination),
  ])
  const unknown = Object.keys(raw).find(key => !allowed.has(key))
  if (unknown) throw new AuditRequestError(unknown, 'unknown_query')
}

function normalizedHash(query: Omit<AuditQuery, 'cursor' | 'filter_hash'>): string {
  const normalized = {
    ...query,
    snapshot: { ...query.snapshot, max_record_id: undefined },
    limit: undefined,
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function parseVisibility(value: string | undefined, admin: boolean): AuditVisibility {
  if (!value) return 'authoritative'
  if (!admin || !AUDIT_VISIBILITIES.includes(value as AuditVisibility)) {
    throw new AuditRequestError('visibility')
  }
  return value as AuditVisibility
}

function parsePricingStatus(value: string | undefined): PricingStatus | null {
  if (!value) return null
  if (!PRICING_STATUSES.includes(value as PricingStatus)) {
    throw new AuditRequestError('pricing_status')
  }
  return value as PricingStatus
}

export function parseAuditQuery(
  db: DB,
  raw: RawQuery,
  options: QueryOptions,
): AuditQuery {
  assertAllowed(raw, options)
  const now = options.now ?? new Date()
  const cursor = options.pagination === false ? null : decodeCursor(raw.cursor)
  const currentMax = currentMaxRecordId(db)
  const maxRecordId = parseInteger(
    raw.snapshot_max_id,
    cursor?.snapshot_max_id ?? currentMax,
    'snapshot_max_id', 0, currentMax,
  )
  if (cursor && cursor.snapshot_max_id !== maxRecordId) {
    throw new AuditRequestError('cursor', 'cursor_snapshot_mismatch')
  }
  const device = boundedText(raw.device ?? raw.device_id, 'device')
  if (raw.device && raw.device_id && raw.device !== raw.device_id) {
    throw new AuditRequestError('device')
  }
  const snapshot = {
    since: parseIso(raw.since, EPOCH, 'since'),
    until: parseIso(raw.until, now.toISOString(), 'until'),
    timezone_offset: parseInteger(raw.timezone_offset, 0, 'timezone_offset', -840, 840),
    max_record_id: maxRecordId,
  }
  if (snapshot.since >= snapshot.until) throw new AuditRequestError('until', 'invalid_window')
  const base = {
    snapshot,
    visibility: parseVisibility(raw.visibility, options.admin),
    device,
    provider: boundedText(raw.provider, 'provider'),
    model: boundedText(raw.model, 'model'),
    pricing_status: parsePricingStatus(raw.pricing_status),
    source_marker: options.admin ? boundedText(raw.source_marker, 'source_marker') : null,
    dedup_key: options.admin ? boundedText(raw.dedup_key, 'dedup_key') : null,
    project_group_id: optionalPositiveInteger(raw.project_group_id, 'project_group_id'),
    session_id: boundedText(raw.session_id, 'session_id'),
    limit: options.pagination === false
      ? DEFAULT_LIMIT
      : parseInteger(raw.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT),
  }
  const filterHash = normalizedHash(base)
  if (cursor && cursor.filter_hash !== filterHash) {
    throw new AuditRequestError('cursor', 'cursor_filter_mismatch')
  }
  return { ...base, cursor, filter_hash: filterHash }
}

function visibilityCondition(query: AuditQuery, visibility: AuditVisibility): string | null {
  const authority = buildAuthoritativeSourceFilter('u', query.snapshot.max_record_id)
  if (visibility === 'authoritative') return authority
  if (visibility === 'hidden') return `NOT ${authority}`
  return null
}

function buildUsageWhere(
  query: AuditQuery,
  visibility = query.visibility,
  includeCursor = false,
): SqlFilter {
  const conditions = ['u.timestamp >= ?', 'u.timestamp < ?', 'u.id <= ?']
  const params: Array<string | number> = [
    query.snapshot.since, query.snapshot.until, query.snapshot.max_record_id,
  ]
  const optional: Array<[string | null, string]> = [
    [query.device, 'u.device_id = ?'], [query.provider, 'u.provider = ?'],
    [query.model, 'u.model = ?'], [query.pricing_status, 'u.pricing_status = ?'],
    [query.source_marker, "COALESCE(u.source_file, '') = ?"],
    [query.dedup_key, "COALESCE(u.dedup_key, '') = ?"],
    [query.session_id, "COALESCE(u.session_id, '') = ?"],
  ]
  for (const [value, sql] of optional) {
    if (value != null) { conditions.push(sql); params.push(value) }
  }
  if (query.project_group_id != null) {
    conditions.push(`EXISTS (
      SELECT 1 FROM attribution_projects attribution_project
      WHERE attribution_project.device_id = u.device_id
        AND attribution_project.project_id = u.project_id
        AND attribution_project.group_id = ?
    )`)
    params.push(query.project_group_id)
  }
  const visibilitySql = visibilityCondition(query, visibility)
  if (visibilitySql) conditions.push(visibilitySql)
  if (includeCursor && query.cursor) {
    conditions.push('(u.timestamp < ? OR (u.timestamp = ? AND u.id < ?))')
    params.push(query.cursor.timestamp, query.cursor.timestamp, query.cursor.id)
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params }
}

function recordColumns(admin: boolean, query: AuditQuery): string {
  const internal = admin ? `,
    u.source_file, u.dedup_key, u.pricing_rule_id, u.pricing_source,
    u.created_at,
    CASE WHEN ${buildAuthoritativeSourceFilter('u', query.snapshot.max_record_id)}
      THEN 1 ELSE 0 END AS is_authoritative` : ''
  return `u.id, u.device_id, d.name AS device_name, u.provider, u.model,
    u.request_count, u.input_tokens, u.output_tokens, u.cache_read_tokens,
    u.cache_creation_tokens, u.reasoning_tokens, u.input_includes_cache_read,
    u.input_includes_cache_creation, u.output_includes_reasoning,
    ${freshInputTokensSql('u')} AS fresh_input_tokens,
    ${billableOutputTokensSql('u')} AS billable_output_tokens,
    ${realTotalTokensSql('u')} AS real_total_tokens,
    u.cost_usd, u.pricing_status, u.timestamp,
    u.attribution_version, u.attribution_status, u.project_id, u.session_id,
    (SELECT p.group_id FROM attribution_projects p
      WHERE p.device_id = u.device_id AND p.project_id = u.project_id
    ) AS project_group_id,
    (SELECT g.display_name FROM attribution_projects p
      JOIN attribution_project_groups g ON g.id = p.group_id
      WHERE p.device_id = u.device_id AND p.project_id = u.project_id
    ) AS project_name${internal}`
}

function publicRecord(row: UsageRow): AuditPublicRecord {
  const status = row.attribution_status == null
    ? 'unknown' : String(row.attribution_status) as AttributionDisplayStatus
  return {
    id: Number(row.id), device_id: String(row.device_id), device_name: String(row.device_name),
    provider: String(row.provider), model: String(row.model),
    request_count: Number(row.request_count), input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens), cache_read_tokens: Number(row.cache_read_tokens),
    cache_creation_tokens: Number(row.cache_creation_tokens),
    reasoning_tokens: Number(row.reasoning_tokens),
    input_includes_cache_read: row.input_includes_cache_read === 1,
    input_includes_cache_creation: row.input_includes_cache_creation === 1,
    output_includes_reasoning: row.output_includes_reasoning === 1,
    fresh_input_tokens: Number(row.fresh_input_tokens),
    billable_output_tokens: Number(row.billable_output_tokens),
    real_total_tokens: Number(row.real_total_tokens), cost_usd: Number(row.cost_usd),
    pricing_status: row.pricing_status, timestamp: String(row.timestamp),
    attribution_version: row.attribution_version == null
      ? null : Number(row.attribution_version),
    attribution_status: status,
    project_id: row.project_id == null ? null : String(row.project_id),
    session_id: row.session_id == null ? null : String(row.session_id),
    project_group_id: row.project_group_id == null ? null : Number(row.project_group_id),
    project_name: row.project_name == null ? null : String(row.project_name),
  }
}

function adminRecord(
  row: UsageRow,
  rules: Map<number, PricingRuleWithAliases>,
): AuditAdminRecord {
  const record = publicRecord(row)
  const ruleId = row.pricing_rule_id == null ? null : Number(row.pricing_rule_id)
  return {
    ...record, source_file: row.source_file == null ? null : String(row.source_file),
    dedup_key: row.dedup_key == null ? null : String(row.dedup_key),
    pricing_rule_id: ruleId,
    pricing_source: row.pricing_source == null ? null : String(row.pricing_source),
    created_at: row.created_at == null ? null : String(row.created_at),
    is_authoritative: row.is_authoritative === 1,
    pricing_explanation: pricingExplanation(record, ruleId, rules),
  }
}

function ruleMap(db: DB): Map<number, PricingRuleWithAliases> {
  return new Map(listPricingRules(db).map(rule => [rule.id, rule]))
}

function pageCursor(query: AuditQuery, row: AuditPublicRecord): string {
  return encodeCursor({
    version: 1, timestamp: row.timestamp, id: row.id,
    snapshot_max_id: query.snapshot.max_record_id, filter_hash: query.filter_hash,
  })
}

export function getAuditRecords(
  db: DB,
  raw: RawQuery,
  admin: false,
): AuditRecordsPage<AuditPublicRecord>
export function getAuditRecords(
  db: DB,
  raw: RawQuery,
  admin: true,
): AuditRecordsPage<AuditAdminRecord>
export function getAuditRecords(
  db: DB,
  raw: RawQuery,
  admin: boolean,
): AuditRecordsPage<AuditPublicRecord | AuditAdminRecord> {
  const query = parseAuditQuery(db, raw, { admin })
  const filter = buildUsageWhere(query, query.visibility, true)
  const rows = db.prepare(`SELECT ${recordColumns(admin, query)}
    FROM usage_records u JOIN devices d ON d.id = u.device_id
    ${filter.sql} ORDER BY u.timestamp DESC, u.id DESC LIMIT ?`
  ).all(...filter.params, query.limit + 1) as UsageRow[]
  const hasMore = rows.length > query.limit
  const visible = rows.slice(0, query.limit)
  const rules = admin ? ruleMap(db) : new Map<number, PricingRuleWithAliases>()
  const records = visible.map(row => admin ? adminRecord(row, rules) : publicRecord(row))
  return {
    snapshot: query.snapshot, visibility: query.visibility, rows: records,
    next_cursor: hasMore && records.length ? pageCursor(query, records.at(-1)!) : null,
  }
}

interface SummaryRow {
  records: number
  calls: number | null
  tokens: number | null
  cost: number | null
  unpriced_calls: number | null
  unpriced_tokens: number | null
  last_usage_at: string | null
}

function summarize(db: DB, query: AuditQuery, visibility: AuditVisibility): AuditMetricSummary {
  const filter = buildUsageWhere(query, visibility)
  const total = realTotalTokensSql('u')
  const row = db.prepare(`SELECT COUNT(*) AS records, SUM(u.request_count) AS calls,
    SUM(${total}) AS tokens, SUM(u.cost_usd) AS cost,
    SUM(CASE WHEN u.pricing_status IN (${INCOMPLETE_SQL}) THEN u.request_count ELSE 0 END) AS unpriced_calls,
    SUM(CASE WHEN u.pricing_status IN (${INCOMPLETE_SQL}) THEN ${total} ELSE 0 END) AS unpriced_tokens,
    MAX(u.timestamp) AS last_usage_at FROM usage_records u ${filter.sql}`
  ).get(...filter.params) as SummaryRow
  const calls = Number(row.calls) || 0
  const tokens = Number(row.tokens) || 0
  return {
    records: Number(row.records) || 0, calls, real_total_tokens: tokens,
    cost_usd: Number(row.cost) || 0,
    pricing_coverage: buildCostCoverage(
      calls, tokens, Number(row.unpriced_calls) || 0, Number(row.unpriced_tokens) || 0,
    ),
    last_usage_at: row.last_usage_at,
  }
}

export function getAuditSummary(db: DB, raw: RawQuery): AuditSummaryResponse {
  const query = parseAuditQuery(db, raw, { admin: true, pagination: false })
  const summaries = {
    authoritative: summarize(db, query, 'authoritative'),
    physical: summarize(db, query, 'physical'),
    hidden: summarize(db, query, 'hidden'),
  }
  return { snapshot: query.snapshot, selected: summaries[query.visibility], ...summaries }
}

function ledgerMap(db: DB, query: AuditQuery): Map<string, AuditMetricSummary> {
  const filter = buildUsageWhere(query, 'authoritative')
  const total = realTotalTokensSql('u')
  const rows = db.prepare(`SELECT u.device_id, d.name AS device_name, u.provider,
    COUNT(*) AS records, SUM(u.request_count) AS calls, SUM(${total}) AS tokens,
    SUM(u.cost_usd) AS cost,
    SUM(CASE WHEN u.pricing_status IN (${INCOMPLETE_SQL}) THEN u.request_count ELSE 0 END) AS unpriced_calls,
    SUM(CASE WHEN u.pricing_status IN (${INCOMPLETE_SQL}) THEN ${total} ELSE 0 END) AS unpriced_tokens,
    MAX(u.timestamp) AS last_usage_at
    FROM usage_records u JOIN devices d ON d.id = u.device_id ${filter.sql}
    GROUP BY u.device_id, d.name, u.provider`
  ).all(...filter.params) as Array<SummaryRow & { device_id: string; provider: string }>
  return new Map(rows.map(row => {
    const calls = Number(row.calls) || 0
    const tokens = Number(row.tokens) || 0
    return [`${row.device_id}\u0000${row.provider}`, {
      records: Number(row.records), calls, real_total_tokens: tokens,
      cost_usd: Number(row.cost) || 0,
      pricing_coverage: buildCostCoverage(
        calls, tokens, Number(row.unpriced_calls) || 0, Number(row.unpriced_tokens) || 0,
      ),
      last_usage_at: row.last_usage_at,
    }]
  }))
}

function emptySummary(): AuditMetricSummary {
  return {
    records: 0, calls: 0, real_total_tokens: 0, cost_usd: 0,
    pricing_coverage: buildCostCoverage(0, 0, 0, 0), last_usage_at: null,
  }
}
export function getAuditReconciliation(
  db: DB,
  raw: RawQuery,
): AuditReconciliationResponse {
  const query = parseAuditQuery(db, raw, { admin: true, pagination: false })
  const conditions = ['r.finished_at >= ?', 'r.finished_at < ?']
  const params: string[] = [query.snapshot.since, query.snapshot.until]
  if (query.device) { conditions.push('r.device_id = ?'); params.push(query.device) }
  if (query.provider) { conditions.push('s.source = ?'); params.push(query.provider) }
  const rows = db.prepare(`SELECT r.device_id, d.name AS device_name, s.source,
    COUNT(*) AS runs, SUM(CASE WHEN s.status = 'success' THEN 1 ELSE 0 END) AS successful_runs,
    SUM(CASE WHEN s.status <> 'success' THEN 1 ELSE 0 END) AS failed_runs,
    SUM(s.emitted) AS emitted, SUM(COALESCE(s.accepted, 0)) AS accepted,
    SUM(COALESCE(s.unchanged, 0)) AS unchanged,
    SUM(CASE WHEN s.accepted IS NULL THEN 1 ELSE 0 END) AS unknown_acknowledgements,
    SUM(CASE WHEN s.accepted IS NULL THEN 0
      ELSE s.emitted - s.accepted - s.unchanged END) AS pipeline_balance,
    MAX(s.watermark_at) AS latest_watermark_at,
    MAX(s.last_usage_at) AS reported_last_usage_at
    FROM collector_source_runs s JOIN collector_runs r ON r.run_id = s.run_id
    JOIN devices d ON d.id = r.device_id
    WHERE ${conditions.join(' AND ')} GROUP BY r.device_id, d.name, s.source
    ORDER BY d.name, s.source`
  ).all(...params) as Array<Record<string, unknown> & { device_id: string; source: string }>
  const ledgers = ledgerMap(db, query)
  const telemetryCoverage = getCollectorTelemetryCoverage(db, {
    deviceId: query.device ?? undefined, source: query.provider ?? undefined, since: query.snapshot.since,
  })
  return {
    snapshot: query.snapshot, run_since: query.snapshot.since,
    run_until: query.snapshot.until,
    telemetry_coverage: telemetryCoverage,
    rows: rows.map(row => ({
      device_id: row.device_id, device_name: String(row.device_name), source: row.source,
      runs: Number(row.runs), successful_runs: Number(row.successful_runs),
      failed_runs: Number(row.failed_runs), emitted: Number(row.emitted),
      accepted: Number(row.accepted), unchanged: Number(row.unchanged),
      unknown_acknowledgements: Number(row.unknown_acknowledgements),
      pipeline_balance: Number(row.pipeline_balance),
      latest_watermark_at: row.latest_watermark_at == null ? null : String(row.latest_watermark_at),
      reported_last_usage_at: row.reported_last_usage_at == null
        ? null : String(row.reported_last_usage_at),
      ledger: ledgers.get(`${row.device_id}\u0000${row.source}`) ?? emptySummary(),
    })),
  }
}

interface CutoverCursor { version: 1; id: number; snapshot_max_id: number; filter_hash: string }

function cutoverCursor(value: string | undefined): CutoverCursor | null {
  if (!value) return null
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CutoverCursor
    if (cursor.version !== 1 || !Number.isInteger(cursor.id) || cursor.id <= 0
      || !Number.isInteger(cursor.snapshot_max_id) || cursor.snapshot_max_id < 0
      || typeof cursor.filter_hash !== 'string') throw new Error('shape')
    return cursor
  } catch { throw new AuditRequestError('cursor', 'invalid_cursor') }
}

export function getAuditCutoverEvents(db: DB, raw: RawQuery): AuditCutoverPage {
  const allowed = new Set(['device', 'device_id', 'provider', 'limit', 'cursor'])
  const unknown = Object.keys(raw).find(key => !allowed.has(key))
  if (unknown) throw new AuditRequestError(unknown, 'unknown_query')
  const device = boundedText(raw.device ?? raw.device_id, 'device')
  const provider = boundedText(raw.provider, 'provider')
  const cursor = cutoverCursor(raw.cursor)
  const current = db.prepare('SELECT MAX(id) AS id FROM source_cutover_events').get() as { id: number | null }
  const maxId = cursor?.snapshot_max_id ?? (Number(current.id) || 0)
  const hash = createHash('sha256').update(JSON.stringify({ device, provider })).digest('hex')
  if (cursor?.filter_hash !== undefined && cursor.filter_hash !== hash) {
    throw new AuditRequestError('cursor', 'cursor_filter_mismatch')
  }
  const limit = parseInteger(raw.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT)
  const conditions = ['e.id <= ?']
  const params: Array<string | number> = [maxId]
  if (device) { conditions.push('e.device_id = ?'); params.push(device) }
  if (provider) { conditions.push('e.provider = ?'); params.push(provider) }
  if (cursor) { conditions.push('e.id < ?'); params.push(cursor.id) }
  const rows = db.prepare(`SELECT e.*, d.name AS device_name
    FROM source_cutover_events e JOIN devices d ON d.id = e.device_id
    WHERE ${conditions.join(' AND ')} ORDER BY e.id DESC LIMIT ?`
  ).all(...params, limit + 1) as Array<Record<string, unknown> & { id: number }>
  const visible = rows.slice(0, limit)
  const next = rows.length > limit && visible.length
    ? Buffer.from(JSON.stringify({ version: 1, id: visible.at(-1)!.id,
      snapshot_max_id: maxId, filter_hash: hash })).toString('base64url')
    : null
  return {
    rows: visible.map(row => ({
      id: Number(row.id), device_id: String(row.device_id),
      device_name: String(row.device_name), provider: String(row.provider),
      previous_cutover_at: row.previous_cutover_at == null ? null : String(row.previous_cutover_at),
      cutover_at: row.cutover_at == null ? null : String(row.cutover_at),
      actor: String(row.actor), reason: String(row.reason), created_at: String(row.created_at),
    })),
    next_cursor: next,
  }
}

export interface AuditExport {
  snapshot: QuerySnapshot
  visibility: AuditVisibility
  rows: IterableIterator<AuditAdminRecord>
}

export function getAuditExport(db: DB, raw: RawQuery): AuditExport {
  const query = parseAuditQuery(db, raw, { admin: true, pagination: false })
  const filter = buildUsageWhere(query)
  const statement = db.prepare(`SELECT ${recordColumns(true, query)}
    FROM usage_records u JOIN devices d ON d.id = u.device_id
    ${filter.sql} ORDER BY u.timestamp DESC, u.id DESC`)
  const rules = ruleMap(db)
  function* records(): IterableIterator<AuditAdminRecord> {
    for (const row of statement.iterate(...filter.params) as IterableIterator<UsageRow>) {
      yield adminRecord(row, rules)
    }
  }
  return { snapshot: query.snapshot, visibility: query.visibility, rows: records() }
}
