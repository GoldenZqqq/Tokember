import type { DB } from './db.js'

export const COLLECTOR_RETENTION_DAYS = 90
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000

interface MaintenanceRow {
  last_attempted_at: string | null
  coverage_since: string | null
}

export interface CollectorTelemetryCoverage {
  coverage_since: string | null
  earliest_retained_at: string | null
  latest_retained_at: string | null
  truncated: boolean
}

function isoNow(now: Date): string {
  return now.toISOString()
}

function cutoffAt(now: Date): string {
  return new Date(now.getTime() - COLLECTOR_RETENTION_DAYS * 24 * 60 * 60_000).toISOString()
}

function claimMaintenance(db: DB, now: string): boolean {
  const row = db.prepare(`
    SELECT last_attempted_at FROM collector_telemetry_maintenance WHERE id = 1
  `).get() as { last_attempted_at: string | null } | undefined
  if (row?.last_attempted_at && Date.parse(now) - Date.parse(row.last_attempted_at) < MAINTENANCE_INTERVAL_MS) {
    return false
  }
  db.prepare(`
    INSERT INTO collector_telemetry_maintenance (id, last_attempted_at)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_attempted_at = excluded.last_attempted_at
  `).run(now)
  return true
}

const RETENTION_DELETE_SQL = `
  WITH ranked_runs AS (
    SELECT run_id, device_id, status,
      ROW_NUMBER() OVER (
        PARTITION BY device_id ORDER BY finished_at DESC, run_id DESC
      ) AS recency
    FROM collector_runs
  ), latest_success_runs AS (
    SELECT run_id, device_id,
      ROW_NUMBER() OVER (
        PARTITION BY device_id ORDER BY finished_at DESC, run_id DESC
      ) AS recency
    FROM collector_runs WHERE status = 'success'
  ), ranked_sources AS (
    SELECT s.run_id, r.device_id, s.source, s.status, r.finished_at,
      ROW_NUMBER() OVER (
        PARTITION BY r.device_id, s.source ORDER BY r.finished_at DESC, r.run_id DESC
      ) AS recency
    FROM collector_source_runs s JOIN collector_runs r ON r.run_id = s.run_id
  ), latest_success_sources AS (
    SELECT s.run_id, r.device_id, s.source,
      ROW_NUMBER() OVER (
        PARTITION BY r.device_id, s.source ORDER BY r.finished_at DESC, r.run_id DESC
      ) AS recency
    FROM collector_source_runs s JOIN collector_runs r ON r.run_id = s.run_id
    WHERE s.status = 'success'
  ), marked_sources AS (
    SELECT *, MIN(CASE WHEN status = 'success' THEN recency END) OVER (
      PARTITION BY device_id, source
    ) AS first_success_recency
    FROM ranked_sources
  ), latest_watermarks AS (
    SELECT s.run_id, r.device_id, s.source,
      ROW_NUMBER() OVER (
        PARTITION BY r.device_id, s.source
        ORDER BY s.watermark_at DESC, r.finished_at DESC, r.run_id DESC
      ) AS recency
    FROM collector_source_runs s JOIN collector_runs r ON r.run_id = s.run_id
    WHERE s.watermark_at IS NOT NULL
  ), latest_usage AS (
    SELECT s.run_id, r.device_id, s.source,
      ROW_NUMBER() OVER (
        PARTITION BY r.device_id, s.source
        ORDER BY s.last_usage_at DESC, r.finished_at DESC, r.run_id DESC
      ) AS recency
    FROM collector_source_runs s JOIN collector_runs r ON r.run_id = s.run_id
    WHERE s.last_usage_at IS NOT NULL
  ), failure_streak AS (
    SELECT run_id FROM marked_sources
    WHERE status <> 'success'
      AND (first_success_recency IS NULL OR recency < first_success_recency)
  ), protected AS (
    SELECT run_id FROM ranked_runs WHERE recency = 1
    UNION SELECT run_id FROM latest_success_runs WHERE recency = 1
    UNION SELECT run_id FROM ranked_sources WHERE recency = 1
    UNION SELECT run_id FROM latest_success_sources WHERE recency = 1
    UNION SELECT run_id FROM latest_watermarks WHERE recency = 1
    UNION SELECT run_id FROM latest_usage WHERE recency = 1
    UNION SELECT run_id FROM failure_streak
  )
  DELETE FROM collector_runs
  WHERE finished_at < ?
    AND NOT EXISTS (SELECT 1 FROM protected WHERE protected.run_id = collector_runs.run_id)
`

export function maintainCollectorTelemetry(db: DB, now = new Date()): void {
  const attemptedAt = isoNow(now)
  if (!claimMaintenance(db, attemptedAt)) return
  const cutoff = cutoffAt(now)
  db.transaction(() => {
    db.prepare(RETENTION_DELETE_SQL).run(cutoff)
    db.prepare(`
      UPDATE collector_telemetry_maintenance
      SET coverage_since = CASE
        WHEN coverage_since IS NULL OR coverage_since < ? THEN ?
        ELSE coverage_since
      END
      WHERE id = 1
    `).run(cutoff, cutoff)
  })()
}

export function getCollectorTelemetryCoverage(
  db: DB,
  filters: { deviceId?: string; source?: string; since?: string } = {},
): CollectorTelemetryCoverage {
  const conditions = ['1 = 1']
  const params: string[] = []
  if (filters.deviceId) { conditions.push('r.device_id = ?'); params.push(filters.deviceId) }
  if (filters.source) { conditions.push('s.source = ?'); params.push(filters.source) }
  const row = db.prepare(`
    SELECT MIN(r.finished_at) AS earliest_retained_at,
      MAX(r.finished_at) AS latest_retained_at
    FROM collector_runs r
    LEFT JOIN collector_source_runs s ON s.run_id = r.run_id
    WHERE ${conditions.join(' AND ')}
  `).get(...params) as {
    earliest_retained_at: string | null
    latest_retained_at: string | null
  }
  const marker = db.prepare(`
    SELECT coverage_since FROM collector_telemetry_maintenance WHERE id = 1
  `).get() as MaintenanceRow | undefined
  const coverageSince = marker?.coverage_since ?? null
  return {
    coverage_since: coverageSince,
    earliest_retained_at: row.earliest_retained_at,
    latest_retained_at: row.latest_retained_at,
    truncated: filters.since != null && coverageSince != null && filters.since < coverageSince,
  }
}
