import type { DB } from './db.js'
import type {
  ProjectAttributionGroup,
  ProjectAttributionMember,
  ProjectAttributionResponse,
} from '@tokember/contracts/attribution'
import { buildAuthoritativeSourceFilter } from './source-authority.js'
import {
  buildCostCoverage,
  INCOMPLETE_PRICING_STATUSES,
  realTotalTokensSql,
} from './usage-metrics.js'

export interface ProjectMembership {
  device_id: string
  project_id: string
  group_id: number
  display_name: string | null
  first_seen_at: string
  last_seen_at: string
}

export function ensureProjectMembership(
  db: DB,
  deviceId: string,
  projectId: string,
  seenAt: string,
): number {
  const existing = db.prepare(`
    SELECT group_id FROM attribution_projects
    WHERE device_id = ? AND project_id = ?
  `).get(deviceId, projectId) as { group_id: number } | undefined
  if (existing) {
    db.prepare(`
      UPDATE attribution_projects SET last_seen_at = MAX(last_seen_at, ?)
      WHERE device_id = ? AND project_id = ?
    `).run(seenAt, deviceId, projectId)
    return existing.group_id
  }
  const group = db.prepare('INSERT INTO attribution_project_groups DEFAULT VALUES').run()
  const groupId = Number(group.lastInsertRowid)
  db.prepare(`
    INSERT INTO attribution_projects
      (device_id, project_id, group_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(deviceId, projectId, groupId, seenAt, seenAt)
  return groupId
}

export function listProjectMemberships(db: DB): ProjectMembership[] {
  return db.prepare(`
    SELECT p.device_id, p.project_id, p.group_id, g.display_name,
      p.first_seen_at, p.last_seen_at
    FROM attribution_projects p
    JOIN attribution_project_groups g ON g.id = p.group_id
    ORDER BY COALESCE(g.display_name, ''), p.last_seen_at DESC, p.device_id, p.project_id
  `).all() as ProjectMembership[]
}

const INCOMPLETE_SQL = INCOMPLETE_PRICING_STATUSES.map(value => `'${value}'`).join(', ')

interface ProjectMetricRow extends ProjectMembership {
  device_name: string
  calls: number
  real_total_tokens: number
  cost: number
  unpriced_calls: number
  unpriced_tokens: number
}

function member(row: ProjectMetricRow): ProjectAttributionMember {
  const calls = Number(row.calls) || 0
  const tokens = Number(row.real_total_tokens) || 0
  return {
    device_id: row.device_id, device_name: row.device_name,
    project_id: row.project_id, first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at, calls, real_total_tokens: tokens,
    cost: Number(row.cost) || 0,
    pricing_coverage: buildCostCoverage(
      calls, tokens, Number(row.unpriced_calls) || 0, Number(row.unpriced_tokens) || 0,
    ),
  }
}

function group(
  id: number,
  displayName: string | null,
  members: ProjectAttributionMember[],
): ProjectAttributionGroup {
  const totals = members.reduce((sum, item) => ({
    calls: sum.calls + item.calls,
    tokens: sum.tokens + item.real_total_tokens,
    cost: sum.cost + item.cost,
    unpricedCalls: sum.unpricedCalls + item.pricing_coverage.unpriced_calls,
    unpricedTokens: sum.unpricedTokens + item.pricing_coverage.unpriced_tokens,
  }), { calls: 0, tokens: 0, cost: 0, unpricedCalls: 0, unpricedTokens: 0 })
  return {
    id, display_name: displayName, members,
    calls: totals.calls, real_total_tokens: totals.tokens, cost: totals.cost,
    pricing_coverage: buildCostCoverage(
      totals.calls, totals.tokens, totals.unpricedCalls, totals.unpricedTokens,
    ),
  }
}

export function getProjectAttribution(db: DB): ProjectAttributionResponse {
  const total = realTotalTokensSql('u')
  const rows = db.prepare(`
    SELECT p.device_id, d.name AS device_name, p.project_id, p.group_id,
      g.display_name, p.first_seen_at, p.last_seen_at,
      SUM(u.request_count) AS calls, SUM(${total}) AS real_total_tokens,
      SUM(u.cost_usd) AS cost,
      SUM(CASE WHEN u.pricing_status IN (${INCOMPLETE_SQL})
        THEN u.request_count ELSE 0 END) AS unpriced_calls,
      SUM(CASE WHEN u.pricing_status IN (${INCOMPLETE_SQL})
        THEN ${total} ELSE 0 END) AS unpriced_tokens
    FROM attribution_projects p
    JOIN attribution_project_groups g ON g.id = p.group_id
    JOIN devices d ON d.id = p.device_id
    JOIN usage_records u
      ON u.device_id = p.device_id AND u.project_id = p.project_id
    WHERE ${buildAuthoritativeSourceFilter('u')}
    GROUP BY p.device_id, d.name, p.project_id, p.group_id, g.display_name,
      p.first_seen_at, p.last_seen_at
    ORDER BY COALESCE(g.display_name, ''), p.last_seen_at DESC
  `).all() as ProjectMetricRow[]
  const groups = new Map<number, ProjectAttributionGroup>()
  for (const row of rows) {
    const existing = groups.get(row.group_id)
    const members = [...(existing?.members ?? []), member(row)]
    groups.set(row.group_id, group(row.group_id, row.display_name, members))
  }
  return { groups: [...groups.values()] }
}

export function updateProjectGroupName(
  db: DB,
  groupId: number,
  displayName: string | null,
): boolean {
  return db.prepare(`
    UPDATE attribution_project_groups
    SET display_name = ?, updated_at = datetime('now') WHERE id = ?
  `).run(displayName, groupId).changes > 0
}

export function mergeProjectMembership(
  db: DB,
  deviceId: string,
  projectId: string,
  targetGroupId: number,
): boolean {
  return db.transaction(() => {
    const source = db.prepare(`
      SELECT group_id FROM attribution_projects
      WHERE device_id = ? AND project_id = ?
    `).get(deviceId, projectId) as { group_id: number } | undefined
    const target = db.prepare('SELECT 1 FROM attribution_project_groups WHERE id = ?')
      .get(targetGroupId)
    if (!source || !target) return false
    if (source.group_id === targetGroupId) return true
    db.prepare(`
      UPDATE attribution_projects SET group_id = ?
      WHERE device_id = ? AND project_id = ?
    `).run(targetGroupId, deviceId, projectId)
    db.prepare(`
      DELETE FROM attribution_project_groups WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM attribution_projects WHERE group_id = ?
        )
    `).run(source.group_id, source.group_id)
    return true
  })()
}
