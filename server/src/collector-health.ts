import type {
  CollectorDeviceHealth,
  CollectorRunStatus,
  CollectorSourceHealth,
  CollectorSourceStatus,
} from '@tokember/contracts/collector-observability'
import type { DB } from './db.js'

const FRESHNESS_MULTIPLIER = 2.5
const MINUTE_MS = 60_000

interface RunRow {
  run_id: string
  device_id: string
  status: CollectorRunStatus
  started_at: string
  finished_at: string
  duration_ms: number
  schedule_interval_minutes: number
  emitted: number
  accepted: number | null
  unchanged: number | null
  error_summary: string | null
}

interface LatestRunRow extends RunRow {
  last_successful_at: string | null
}

interface SourceRow {
  device_id: string
  finished_at: string
  schedule_interval_minutes: number
  source: string
  status: CollectorSourceStatus
  discovered: number
  scanned: number
  emitted: number
  accepted: number | null
  unchanged: number | null
  watermark_at: string | null
  last_usage_at: string | null
  duration_ms: number
  error_summary: string | null
}

interface LatestSourceRow extends SourceRow {
  consecutive_failures: number
}

const LATEST_RUNS_SQL = `
  WITH ranked AS (
    SELECT run_id, device_id, status, started_at, finished_at, duration_ms,
      schedule_interval_minutes, emitted, accepted, unchanged, error_summary,
      ROW_NUMBER() OVER (
        PARTITION BY device_id ORDER BY finished_at DESC, run_id DESC
      ) AS recency,
      MAX(CASE WHEN status = 'success' THEN finished_at END) OVER (
        PARTITION BY device_id
      ) AS last_successful_at
    FROM collector_runs
  )
  SELECT run_id, device_id, status, started_at, finished_at, duration_ms,
    schedule_interval_minutes, emitted, accepted, unchanged, error_summary,
    last_successful_at
  FROM ranked WHERE recency = 1
  ORDER BY device_id
`

const LATEST_SOURCES_SQL = `
  WITH ranked AS (
    SELECT r.device_id, r.finished_at, r.run_id, r.schedule_interval_minutes,
      s.source, s.status,
      s.discovered, s.scanned, s.emitted, s.accepted, s.unchanged,
      s.watermark_at, s.last_usage_at, s.duration_ms, s.error_summary,
      ROW_NUMBER() OVER (
        PARTITION BY r.device_id, s.source
        ORDER BY r.finished_at DESC, r.run_id DESC
      ) AS recency
    FROM collector_source_runs s
    JOIN collector_runs r ON r.run_id = s.run_id
  ), marked AS (
    SELECT *, MIN(CASE WHEN status = 'success' THEN recency END) OVER (
      PARTITION BY device_id, source
    ) AS first_success_recency
    FROM ranked
  ), summarized AS (
    SELECT *,
      SUM(CASE WHEN status <> 'success' AND (
        first_success_recency IS NULL OR recency < first_success_recency
      ) THEN 1 ELSE 0 END) OVER (
        PARTITION BY device_id, source
      ) AS consecutive_failures,
      MAX(watermark_at) OVER (
        PARTITION BY device_id, source
      ) AS latest_watermark_at,
      MAX(last_usage_at) OVER (
        PARTITION BY device_id, source
      ) AS latest_usage_at
    FROM marked
  )
  SELECT device_id, finished_at, schedule_interval_minutes, source, status,
    discovered, scanned, emitted, accepted, unchanged, latest_watermark_at AS watermark_at,
    latest_usage_at AS last_usage_at, duration_ms, error_summary,
    consecutive_failures
  FROM summarized WHERE recency = 1
  ORDER BY device_id, source
`

export function collectorFreshnessThresholdMs(scheduleMinutes: number): number {
  return scheduleMinutes * FRESHNESS_MULTIPLIER * MINUTE_MS
}

function parseTimestamp(value: string): number {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  return Date.parse(normalized)
}

function groupSourceHealth(rows: LatestSourceRow[]): Map<string, CollectorSourceHealth[]> {
  const result = new Map<string, CollectorSourceHealth[]>()
  for (const row of rows) {
    const { device_id: deviceId, schedule_interval_minutes: _schedule, ...source } = row
    result.set(deviceId, [...(result.get(deviceId) ?? []), source])
  }
  return result
}

function statusFor(latest: RunRow | undefined, now: number): CollectorDeviceHealth['status'] {
  if (!latest) return 'never'
  const age = now - parseTimestamp(latest.finished_at)
  if (!Number.isFinite(age)
    || age > collectorFreshnessThresholdMs(latest.schedule_interval_minutes)) return 'offline'
  return latest.status === 'success' ? 'healthy' : 'degraded'
}

export function getCollectorHealthMap(
  db: DB,
  now = Date.now(),
): Map<string, CollectorDeviceHealth> {
  const runs = db.prepare(LATEST_RUNS_SQL).all() as LatestRunRow[]
  const sourceRows = db.prepare(LATEST_SOURCES_SQL).all() as LatestSourceRow[]
  const sources = groupSourceHealth(sourceRows)
  const sourceRowsByDevice = new Map<string, LatestSourceRow[]>()
  for (const row of sourceRows) {
    sourceRowsByDevice.set(row.device_id, [
      ...(sourceRowsByDevice.get(row.device_id) ?? []), row,
    ])
  }
  const devices = new Map<string, CollectorDeviceHealth>()
  for (const run of runs) {
    const { device_id: deviceId, last_successful_at: successful, ...latest } = run
    const deviceSources = sourceRowsByDevice.get(deviceId) ?? []
    const sourceHealth = deviceSources.length > 0
      ? sourceHealthFor(deviceSources, now)
      : null
    const runOnline = successful != null && now - parseTimestamp(successful)
      <= collectorFreshnessThresholdMs(run.schedule_interval_minutes)
    const lastSuccessfulAt = [sourceHealth?.lastSuccessfulAt, successful]
      .filter((value): value is string => value != null)
      .sort()
      .at(-1) ?? null
    devices.set(deviceId, {
      status: sourceHealth?.status ?? statusFor(run, now),
      online: sourceHealth ? sourceHealth.online || runOnline : runOnline,
      freshness_threshold_minutes: sourceHealth
        ? sourceHealth.freshnessThresholdMinutes
        : run.schedule_interval_minutes * FRESHNESS_MULTIPLIER,
      last_successful_at: lastSuccessfulAt,
      latest_run: latest,
      sources: sources.get(deviceId) ?? [],
    })
  }
  return devices
}

function sourceHealthFor(rows: LatestSourceRow[], now: number): {
  status: CollectorDeviceHealth['status']
  online: boolean
  freshnessThresholdMinutes: number | null
  lastSuccessfulAt: string | null
} {
  const freshness = rows.map(row => ({
    row,
    fresh: now - parseTimestamp(row.finished_at)
      <= collectorFreshnessThresholdMs(row.schedule_interval_minutes),
  }))
  const hasFresh = freshness.some(item => item.fresh)
  const hasFreshSuccess = freshness.some(item => item.fresh && item.row.status === 'success')
  const status = !hasFresh
    ? 'offline'
    : freshness.every(item => item.fresh && item.row.status === 'success')
      ? 'healthy'
      : 'degraded'
  const successful = rows
    .filter(row => row.status === 'success')
    .map(row => row.finished_at)
    .sort()
    .at(-1) ?? null
  const thresholds = [...new Set(rows.map(row => row.schedule_interval_minutes * FRESHNESS_MULTIPLIER))]
  return {
    status,
    online: hasFreshSuccess,
    freshnessThresholdMinutes: thresholds.length === 1 ? thresholds[0] : null,
    lastSuccessfulAt: successful,
  }
}

export function emptyCollectorHealth(): CollectorDeviceHealth {
  return {
    status: 'never', online: false, freshness_threshold_minutes: null,
    last_successful_at: null, latest_run: null, sources: [],
  }
}
