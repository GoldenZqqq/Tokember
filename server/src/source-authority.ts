import type {
  SourceAuthorityState as ContractSourceAuthorityState,
  SourceProvider as ContractSourceProvider,
} from '@tokember/contracts/source-authority'
import type { DB } from './db.js'

export type SourceProvider = ContractSourceProvider
export type SourceAuthorityState = ContractSourceAuthorityState
export const SOURCE_PROVIDERS = ['claude', 'codex'] as const satisfies readonly SourceProvider[]

export type CutoverCommitResult = 'created' | 'existing' | 'conflict' | 'missing-device'
export type AdminCutoverResult = 'updated' | 'unchanged' | 'missing-device'

export function parseSourceProvider(value: unknown): SourceProvider | null {
  return typeof value === 'string' && SOURCE_PROVIDERS.includes(value as SourceProvider)
    ? value as SourceProvider
    : null
}

export function parseSourceProviders(value: unknown): SourceProvider[] | null {
  if (value == null) return []
  if (!Array.isArray(value)) return null
  const providers = value.map(parseSourceProvider)
  if (providers.some(provider => provider == null)) return null
  return [...new Set(providers as SourceProvider[])]
}

export function parseCutoverAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) return null
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) return null
  return timestamp.toISOString() === value ? value : null
}

function coverageEnd(timestamp: string, dedupKey: string | null): string | null {
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.getTime())) return null
  if (dedupKey?.startsWith('ccsw-roll:')) {
    parsed.setUTCHours(24, 0, 0, 0)
    return parsed.toISOString()
  }
  return new Date(parsed.getTime() + 1).toISOString()
}

export function getSourceAuthority(
  db: DB,
  deviceId: string,
  provider: SourceProvider,
): SourceAuthorityState {
  const cutover = db.prepare(`
    SELECT cutover_at FROM source_cutovers
    WHERE device_id = ? AND provider = ?
  `).get(deviceId, provider) as { cutover_at: string } | undefined
  const legacy = db.prepare(`
    SELECT timestamp, dedup_key FROM usage_records
    WHERE device_id = ? AND provider = ? AND source_file = 'cc-switch'
    ORDER BY timestamp DESC LIMIT 1
  `).get(deviceId, provider) as { timestamp: string; dedup_key: string | null } | undefined
  return {
    provider,
    cutover_at: cutover?.cutover_at ?? null,
    legacy_history: legacy != null,
    legacy_coverage_end: legacy ? coverageEnd(legacy.timestamp, legacy.dedup_key) : null,
  }
}

export function getSourceAuthorities(
  db: DB,
  deviceId: string,
  providers: SourceProvider[],
): Partial<Record<SourceProvider, SourceAuthorityState>> {
  return Object.fromEntries(
    providers.map(provider => [provider, getSourceAuthority(db, deviceId, provider)]),
  ) as Partial<Record<SourceProvider, SourceAuthorityState>>
}

export function commitSourceCutover(
  db: DB,
  deviceId: string,
  provider: SourceProvider,
  cutoverAt: string,
): CutoverCommitResult {
  return db.transaction((): CutoverCommitResult => {
    const device = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)
    if (!device) return 'missing-device'
    const current = db.prepare(`
      SELECT cutover_at FROM source_cutovers WHERE device_id = ? AND provider = ?
    `).get(deviceId, provider) as { cutover_at: string } | undefined
    if (current) return current.cutover_at === cutoverAt ? 'existing' : 'conflict'
    db.prepare(`
      INSERT INTO source_cutovers
        (device_id, provider, cutover_at, legacy_source, native_source)
      VALUES (?, ?, ?, 'cc-switch', ?)
    `).run(deviceId, provider, cutoverAt, provider === 'claude' ? 'claude-code' : 'codex')
    db.prepare(`
      INSERT INTO source_cutover_events
        (device_id, provider, previous_cutover_at, cutover_at, actor, reason)
      VALUES (?, ?, NULL, ?, 'collector', 'initial native cutover')
    `).run(deviceId, provider, cutoverAt)
    return 'created'
  })()
}

export function setSourceCutoverByAdmin(
  db: DB,
  deviceId: string,
  provider: SourceProvider,
  cutoverAt: string | null,
  reason: string,
): AdminCutoverResult {
  const device = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)
  if (!device) return 'missing-device'
  const current = db.prepare(`
    SELECT cutover_at FROM source_cutovers WHERE device_id = ? AND provider = ?
  `).get(deviceId, provider) as { cutover_at: string } | undefined
  const previous = current?.cutover_at ?? null
  if (previous === cutoverAt) return 'unchanged'
  db.transaction(() => {
    if (cutoverAt == null) {
      db.prepare('DELETE FROM source_cutovers WHERE device_id = ? AND provider = ?')
        .run(deviceId, provider)
    } else {
      db.prepare(`
        INSERT INTO source_cutovers
          (device_id, provider, cutover_at, legacy_source, native_source)
        VALUES (?, ?, ?, 'cc-switch', ?)
        ON CONFLICT(device_id, provider) DO UPDATE SET
          cutover_at = excluded.cutover_at,
          updated_at = datetime('now')
      `).run(deviceId, provider, cutoverAt, provider === 'claude' ? 'claude-code' : 'codex')
    }
    db.prepare(`
      INSERT INTO source_cutover_events
        (device_id, provider, previous_cutover_at, cutover_at, actor, reason)
      VALUES (?, ?, ?, ?, 'admin', ?)
    `).run(deviceId, provider, previous, cutoverAt, reason)
  })()
  return 'updated'
}

function snapshotPredicate(alias: string, maxRecordId?: number): string {
  return maxRecordId == null ? '' : ` AND ${alias}.id <= ${Math.max(0, Math.trunc(maxRecordId))}`
}

function buildAntigravityAuthorityFilter(
  prefix: string,
  maxRecordId?: number,
): string {
  const native = `(${prefix}provider = 'antigravity'
    AND COALESCE(${prefix}dedup_key, '') LIKE 'antigravity:%')`
  const legacyEnd = `(SELECT antigravity_authority.legacy_end FROM (
    SELECT device_id, MAX(timestamp) AS legacy_end
    FROM usage_records AS antigravity_legacy INDEXED BY idx_usage_provider
    WHERE antigravity_legacy.provider = 'antigravity'
      AND COALESCE(antigravity_legacy.dedup_key, '') LIKE 'cb:%'
      ${snapshotPredicate('antigravity_legacy', maxRecordId)}
    GROUP BY device_id
  ) AS antigravity_authority
  WHERE antigravity_authority.device_id = ${prefix}device_id)`
  return `(NOT ${native} OR COALESCE(${prefix}timestamp > ${legacyEnd}, 1))`
}

export function buildAuthoritativeSourceFilter(alias = '', maxRecordId?: number): string {
  const prefix = alias ? `${alias}.` : 'usage_records.'
  const native = `((${prefix}provider = 'codex' AND COALESCE(${prefix}source_file, '') = 'codex')
    OR (${prefix}provider = 'claude' AND COALESCE(${prefix}source_file, '') = 'claude-code'))`
  const legacy = `(${prefix}provider IN ('claude', 'codex')
    AND COALESCE(${prefix}source_file, '') = 'cc-switch')`
  const cutover = `(SELECT authority.cutover_at FROM source_cutovers authority
    WHERE authority.device_id = ${prefix}device_id
      AND authority.provider = ${prefix}provider LIMIT 1)`
  const legacyExists = `EXISTS (SELECT 1 FROM usage_records legacy_history
    WHERE legacy_history.device_id = ${prefix}device_id
      AND legacy_history.provider = ${prefix}provider
      AND legacy_history.source_file = 'cc-switch'
      ${snapshotPredicate('legacy_history', maxRecordId)})`
  const claudeCodexAuthority = `(
    NOT (${native} OR ${legacy})
    OR (${legacy} AND (${cutover} IS NULL OR ${prefix}timestamp < ${cutover}))
    OR (${native} AND (
      (${cutover} IS NOT NULL AND ${prefix}timestamp >= ${cutover})
      OR (${cutover} IS NULL AND NOT ${legacyExists})
    ))
  )`
  return `(${claudeCodexAuthority} AND ${buildAntigravityAuthorityFilter(prefix, maxRecordId)})`
}
