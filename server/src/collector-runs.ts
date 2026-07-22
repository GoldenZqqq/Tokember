import type {
  CollectorKind,
  CollectorRunReport,
  CollectorRunStatus,
  CollectorSourceReport,
  CollectorSourceStatus,
} from '@tokember/contracts/collector-observability'
import type { DB } from './db.js'
import { maintainCollectorTelemetry } from './collector-retention.js'

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/
const MAX_SOURCES = 32
const MAX_ERROR_LENGTH = 500
const MAX_DURATION_MS = 7 * 24 * 60 * 60_000
export const COLLECTOR_RUN_MAX_BODY_BYTES = 64 * 1024
const RUN_STATUSES: CollectorRunStatus[] = ['success', 'partial', 'failed']
const SOURCE_STATUSES: CollectorSourceStatus[] = [
  'success', 'collection_failed', 'upload_failed',
]
const COLLECTOR_KINDS: CollectorKind[] = ['native', 'hermes']

export class CollectorRunRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly field?: string,
  ) {
    super(field ? `${code}: ${field}` : code)
    this.name = 'CollectorRunRequestError'
  }
}

function fail(code: string, field?: string): never {
  throw new CollectorRunRequestError(code, field)
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_field', field)
  }
  return value as Record<string, unknown>
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return fail('invalid_field', field)
  const result = value.trim()
  if (!result || result.length > max) return fail('invalid_field', field)
  return result
}

function countValue(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    return fail('invalid_count', field)
  }
  return value as number
}

function nullableCount(value: unknown, field: string): number | null {
  return value === null ? null : countValue(value, field)
}

function timestampValue(value: unknown, field: string): string {
  const input = boundedString(value, field, 80)
  if (!TIMEZONE_PATTERN.test(input) || !Number.isFinite(Date.parse(input))) {
    return fail('invalid_timestamp', field)
  }
  return new Date(input).toISOString()
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestampValue(value, field)
}

export function sanitizeCollectorError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bx-api-key\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, 'X-API-Key: [redacted]')
    .replace(/\b(?:TOKEMBER_DEVICE_TOKEN|TOKEMBER_API_KEY|AI_BURN_API_KEY|API_KEY)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      match => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\btkdc_[A-Za-z0-9_-]{12,64}_[A-Za-z0-9_-]{32,128}\b/g, '[device-token]')
    .replace(/\b[A-Za-z]:[\\/][^\s,;]+/g, '[path]')
    .replace(/\\\\[^\\\s]+\\[^\s,;]+/g, '[path]')
    .replace(/\/(?:home|Users|var\/lib|tmp|opt)\/[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LENGTH)
}

function sourceStatus(value: unknown, field: string): CollectorSourceStatus {
  return SOURCE_STATUSES.includes(value as CollectorSourceStatus)
    ? value as CollectorSourceStatus
    : fail('invalid_field', field)
}

function decodeSource(value: unknown, index: number): CollectorSourceReport {
  const row = objectValue(value, `sources.${index}`)
  const field = (name: string) => `sources.${index}.${name}`
  const source = boundedString(row.source, field('source'), 80)
  if (!SOURCE_PATTERN.test(source)) fail('invalid_field', field('source'))
  const status = sourceStatus(row.status, field('status'))
  const emitted = countValue(row.emitted, field('emitted'))
  const accepted = nullableCount(row.accepted, field('accepted'))
  const unchanged = nullableCount(row.unchanged, field('unchanged'))
  if ((accepted === null) !== (unchanged === null)
    || (accepted != null && accepted + unchanged! > emitted)
    || (status === 'success' && (accepted == null || accepted + unchanged! !== emitted))) {
    fail('invalid_acknowledgement', field('accepted'))
  }
  const error = sanitizeCollectorError(row.error_summary)
  if (status !== 'success' && error == null) fail('missing_error_summary', field('error_summary'))
  return {
    source, status,
    discovered: countValue(row.discovered, field('discovered')),
    scanned: countValue(row.scanned, field('scanned')),
    emitted, accepted, unchanged,
    watermark_at: nullableTimestamp(row.watermark_at, field('watermark_at')),
    last_usage_at: nullableTimestamp(row.last_usage_at, field('last_usage_at')),
    duration_ms: countValue(row.duration_ms, field('duration_ms'), MAX_DURATION_MS),
    error_summary: error,
  }
}

function runStatus(value: unknown): CollectorRunStatus {
  return RUN_STATUSES.includes(value as CollectorRunStatus)
    ? value as CollectorRunStatus
    : fail('invalid_field', 'status')
}

function collectorKind(value: unknown): CollectorKind {
  return COLLECTOR_KINDS.includes(value as CollectorKind)
    ? value as CollectorKind
    : fail('invalid_field', 'collector_kind')
}

function validateSourceRollup(report: CollectorRunReport): void {
  const emitted = report.sources.reduce((sum, source) => sum + source.emitted, 0)
  if (report.emitted !== emitted) fail('invalid_source_rollup', 'emitted')
  const allKnown = report.sources.every(source => source.accepted != null)
  if (!allKnown) {
    if (report.accepted !== null || report.unchanged !== null) {
      fail('invalid_source_rollup', 'accepted')
    }
  } else {
    const accepted = report.sources.reduce((sum, source) => sum + source.accepted!, 0)
    const unchanged = report.sources.reduce((sum, source) => sum + source.unchanged!, 0)
    if (report.accepted !== accepted || report.unchanged !== unchanged) {
      fail('invalid_source_rollup', 'accepted')
    }
  }
  const successes = report.sources.filter(source => source.status === 'success').length
  const expected = successes === report.sources.length ? 'success' : successes === 0 ? 'failed' : 'partial'
  if (report.status !== expected) fail('invalid_run_status', 'status')
}

export function decodeCollectorRunReport(value: unknown): CollectorRunReport {
  const row = objectValue(value, 'body')
  if (row.schema_version !== 1) fail('unsupported_schema', 'schema_version')
  const runId = boundedString(row.run_id, 'run_id', 120)
  if (!RUN_ID_PATTERN.test(runId)) fail('invalid_field', 'run_id')
  if (!Array.isArray(row.sources) || row.sources.length < 1 || row.sources.length > MAX_SOURCES) {
    fail('invalid_sources', 'sources')
  }
  const sources = row.sources.map(decodeSource)
  if (new Set(sources.map(source => source.source)).size !== sources.length) {
    fail('duplicate_source', 'sources')
  }
  const startedAt = timestampValue(row.started_at, 'started_at')
  const finishedAt = timestampValue(row.finished_at, 'finished_at')
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail('invalid_time_range', 'finished_at')
  const report: CollectorRunReport = {
    schema_version: 1,
    run_id: runId,
    device_id: boundedString(row.device_id, 'device_id', 120),
    collector_kind: collectorKind(row.collector_kind),
    collector_version: boundedString(row.collector_version, 'collector_version', 80),
    schedule_interval_minutes: countValue(
      row.schedule_interval_minutes, 'schedule_interval_minutes', 10_080,
    ),
    started_at: startedAt,
    finished_at: finishedAt,
    status: runStatus(row.status),
    duration_ms: countValue(row.duration_ms, 'duration_ms', MAX_DURATION_MS),
    emitted: countValue(row.emitted, 'emitted'),
    accepted: nullableCount(row.accepted, 'accepted'),
    unchanged: nullableCount(row.unchanged, 'unchanged'),
    error_summary: sanitizeCollectorError(row.error_summary),
    sources,
  }
  if (report.schedule_interval_minutes < 1
    || (report.accepted === null) !== (report.unchanged === null)) {
    fail('invalid_field', 'schedule_interval_minutes')
  }
  validateSourceRollup(report)
  return report
}

export type CollectorRunWriteResult =
  | 'created'
  | 'updated'
  | 'missing-device'
  | 'device-conflict'

export function upsertCollectorRun(db: DB, report: CollectorRunReport): CollectorRunWriteResult {
  const device = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(report.device_id)
  if (!device) return 'missing-device'
  const existing = db.prepare('SELECT device_id FROM collector_runs WHERE run_id = ?')
    .get(report.run_id) as { device_id: string } | undefined
  if (existing && existing.device_id !== report.device_id) return 'device-conflict'
  db.transaction(() => {
    db.prepare(`
      INSERT INTO collector_runs
        (run_id, device_id, report_schema_version, collector_kind,
         collector_version, schedule_interval_minutes, started_at, finished_at,
         status, duration_ms, emitted, accepted, unchanged, error_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        collector_kind = excluded.collector_kind,
        collector_version = excluded.collector_version,
        schedule_interval_minutes = excluded.schedule_interval_minutes,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        status = excluded.status,
        duration_ms = excluded.duration_ms,
        emitted = excluded.emitted,
        accepted = excluded.accepted,
        unchanged = excluded.unchanged,
        error_summary = excluded.error_summary,
        updated_at = datetime('now')
    `).run(
      report.run_id, report.device_id, report.schema_version,
      report.collector_kind, report.collector_version,
      report.schedule_interval_minutes, report.started_at, report.finished_at,
      report.status, report.duration_ms, report.emitted, report.accepted,
      report.unchanged, report.error_summary,
    )
    db.prepare('DELETE FROM collector_source_runs WHERE run_id = ?').run(report.run_id)
    const insert = db.prepare(`
      INSERT INTO collector_source_runs
        (run_id, source, status, discovered, scanned, emitted,
         accepted, unchanged, watermark_at, last_usage_at, duration_ms, error_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const source of report.sources) insert.run(
      report.run_id, source.source, source.status, source.discovered,
      source.scanned, source.emitted, source.accepted, source.unchanged,
      source.watermark_at, source.last_usage_at, source.duration_ms,
      source.error_summary,
    )
  })()
  try {
    maintainCollectorTelemetry(db)
  } catch (error) {
    console.warn('[collector-retention] maintenance deferred', error instanceof Error ? error.name : 'unknown')
  }
  return existing ? 'updated' : 'created'
}
