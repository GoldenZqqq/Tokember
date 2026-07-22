import type { Context, Hono } from 'hono'
import type { DeviceCredentialCreatedResponse } from '@tokember/contracts/security'
import type { DeviceCredentialService } from './device-credentials.js'
import type { LoginService } from './login.js'
import type { SessionService } from './session.js'
import type { SecurityEnv } from './types.js'

function routeId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function registerViewerRoutes(
  api: Hono<SecurityEnv>,
  sessions: SessionService,
  login: LoginService,
): void {
  api.get('/auth/session', c => c.json({
    required: sessions.viewerRequired(),
    authenticated: sessions.canView(c),
  }))
  api.post('/auth/login', c => {
    if (!sessions.viewerRequired()) return c.json({ required: false, authenticated: true })
    return login.login('viewer', c)
  })
  api.post('/auth/logout', c => {
    sessions.logout('viewer', c)
    return c.json({ required: sessions.viewerRequired(), authenticated: false })
  })
}

function createdResponse(
  result: DeviceCredentialCreatedResponse | null | 'missing',
  c: Context,
): Response {
  if (result === 'missing') return c.json({ error: 'credential_not_found' }, 404)
  if (!result) return c.json({ error: 'invalid_device_credential' }, 400)
  return c.json(result)
}

export function registerDeviceCredentialAdminRoutes(
  admin: Hono,
  credentials: DeviceCredentialService,
): void {
  admin.get('/device-credentials', c => c.json(credentials.list()))
  admin.post('/device-credentials', async c => {
    try {
      return createdResponse(credentials.create(await c.req.json().catch(() => null)), c)
    } catch (error) {
      if (error instanceof Error && error.message === 'device_not_found') {
        return c.json({ error: 'device_not_found' }, 404)
      }
      throw error
    }
  })
  admin.post('/device-credentials/:id/rotate', c => {
    const id = routeId(c.req.param('id'))
    if (!id) return c.json({ error: 'invalid_credential_id' }, 400)
    return createdResponse(credentials.rotate(id), c)
  })
  admin.post('/device-credentials/:id/revoke', c => {
    const id = routeId(c.req.param('id'))
    if (!id) return c.json({ error: 'invalid_credential_id' }, 400)
    return credentials.revoke(id)
      ? c.json({ ok: true })
      : c.json({ error: 'credential_not_found' }, 404)
  })
}
