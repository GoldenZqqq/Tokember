import type { Hono } from 'hono'
import type { DB } from './db.js'
import {
  getProjectAttribution,
  mergeProjectMembership,
  updateProjectGroupName,
} from './attribution.js'

function positiveId(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function displayName(value: unknown): string | null | undefined {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.trim() !== value
    || value.length < 1 || value.length > 120) return undefined
  return value
}

export function registerAttributionRoutes(admin: Hono, db: DB): void {
  admin.get('/attribution/projects', c => c.json(getProjectAttribution(db)))

  admin.patch('/attribution/project-groups/:id', async c => {
    const groupId = positiveId(c.req.param('id'))
    const body = await c.req.json().catch(() => null) as { display_name?: unknown } | null
    const name = displayName(body?.display_name)
    if (!groupId || name === undefined) {
      return c.json({ error: 'invalid attribution project input' }, 400)
    }
    if (!updateProjectGroupName(db, groupId, name)) {
      return c.json({ error: 'project group not found' }, 404)
    }
    return c.json({ ok: true, group_id: groupId })
  })

  admin.post('/attribution/projects/merge', async c => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
    const projectId = typeof body?.project_id === 'string' ? body.project_id.trim() : ''
    const targetGroupId = positiveId(String(body?.target_group_id ?? ''))
    if (!deviceId || deviceId.length > 128 || !/^prj_v1_[A-Za-z0-9_-]{43}$/.test(projectId)
      || !targetGroupId) {
      return c.json({ error: 'invalid attribution merge input' }, 400)
    }
    if (!mergeProjectMembership(db, deviceId, projectId, targetGroupId)) {
      return c.json({ error: 'project membership or target group not found' }, 404)
    }
    return c.json({ ok: true, group_id: targetGroupId })
  })
}
