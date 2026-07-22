import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { initDB } from './db.js'
import { apiRoutes } from './routes.js'
import { createCorsMiddleware } from './security/cors.js'
import { DeviceCredentialService } from './security/device-credentials.js'
import { SessionService } from './security/session.js'

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')
  assert.ok(value)
  return value.split(';')[0]
}

function securityEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TOKEMBER_ADMIN_PASSWORD: 'admin-password',
    TOKEMBER_ADMIN_SECRET: 'admin-secret',
    TOKEMBER_COOKIE_SECURE: 'false',
    ...overrides,
  }
}

async function login(
  app: ReturnType<typeof apiRoutes>,
  path: '/auth/login' | '/admin/login',
  password: string,
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

test('optional viewer auth gates ledger reads and admin sessions can view', async () => {
  const openDb = initDB(':memory:')
  const open = apiRoutes(openDb, undefined, { env: securityEnv() })
  assert.equal((await open.request('/stats')).status, 200)
  openDb.close()

  const db = initDB(':memory:')
  const app = apiRoutes(db, undefined, {
    env: securityEnv({ TOKEMBER_VIEWER_PASSWORD: 'viewer-password' }),
  })
  assert.equal((await app.request('/stats')).status, 401)
  assert.equal((await app.request('/devices')).status, 401)

  const viewerLogin = await login(app, '/auth/login', 'viewer-password')
  assert.equal(viewerLogin.status, 200)
  const viewerCookie = cookieFrom(viewerLogin)
  assert.equal((await app.request('/stats', { headers: { Cookie: viewerCookie } })).status, 200)
  assert.equal((await app.request('/admin/system', { headers: { Cookie: viewerCookie } })).status, 401)

  const adminLogin = await login(app, '/admin/login', 'admin-password')
  const adminCookie = cookieFrom(adminLogin)
  assert.equal((await app.request('/stats', { headers: { Cookie: adminCookie } })).status, 200)
  db.close()
})

test('logout revokes the server session and previous secrets support rotation', async () => {
  const db = initDB(':memory:')
  const oldEnv = securityEnv({
    TOKEMBER_VIEWER_PASSWORD: 'viewer-password', TOKEMBER_VIEWER_SECRET: 'old-secret',
  })
  const oldApp = apiRoutes(db, undefined, { env: oldEnv })
  const loginResponse = await login(oldApp, '/auth/login', 'viewer-password')
  const cookie = cookieFrom(loginResponse)

  const rotated = apiRoutes(db, undefined, { env: securityEnv({
    TOKEMBER_VIEWER_PASSWORD: 'viewer-password',
    TOKEMBER_VIEWER_SECRET: 'new-secret',
    TOKEMBER_VIEWER_SECRET_PREVIOUS: 'old-secret',
  }) })
  assert.equal((await rotated.request('/stats', { headers: { Cookie: cookie } })).status, 200)

  const noPrevious = apiRoutes(db, undefined, { env: securityEnv({
    TOKEMBER_VIEWER_PASSWORD: 'viewer-password', TOKEMBER_VIEWER_SECRET: 'new-secret',
  }) })
  assert.equal((await noPrevious.request('/stats', { headers: { Cookie: cookie } })).status, 401)

  const logout = await rotated.request('/auth/logout', {
    method: 'POST', headers: { Cookie: cookie },
  })
  assert.equal(logout.status, 200)
  assert.equal((await rotated.request('/stats', { headers: { Cookie: cookie } })).status, 401)
  db.close()
})

test('expired sessions are rejected even with a valid signature and database row', async () => {
  const db = initDB(':memory:')
  const sessions = new SessionService(db, securityEnv({
    TOKEMBER_VIEWER_PASSWORD: 'viewer-password',
  }))
  const app = new Hono()
  app.get('/issue', c => { sessions.create('viewer', c, new Date('2026-07-01T00:00:00.000Z')); return c.text('ok') })
  app.get('/check', c => c.json({
    authenticated: sessions.authenticated('viewer', c, new Date('2026-07-09T00:00:00.000Z')),
  }))
  const cookie = cookieFrom(await app.request('/issue'))
  const result = await app.request('/check', { headers: { Cookie: cookie } })
  assert.deepEqual(await result.json(), { authenticated: false })
  db.close()
})

test('viewer and admin logins rate-limit the sixth failure without storing addresses', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db, undefined, { env: securityEnv({
    TOKEMBER_VIEWER_PASSWORD: 'viewer-password', TOKEMBER_TRUST_PROXY: 'true',
  }) })
  for (const path of ['/auth/login', '/admin/login'] as const) {
    for (let index = 0; index < 5; index += 1) {
      const response = await app.request(path, {
        method: 'POST', headers: {
          'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9',
        }, body: JSON.stringify({ password: 'wrong' }),
      })
      assert.equal(response.status, 401)
      assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
    }
    const limited = await app.request(path, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9',
      }, body: JSON.stringify({ password: 'admin-password' }),
    })
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), { error: 'too_many_attempts' })
  }
  const serialized = JSON.stringify(db.prepare('SELECT * FROM auth_login_events').all())
  assert.doesNotMatch(serialized, /203\.0\.113\.9|wrong|admin-password/)
  db.close()
})

test('CORS accepts no-origin same-origin and allowlist while rejecting others early', async () => {
  const app = new Hono()
  app.use('*', createCorsMiddleware({
    TOKEMBER_CORS_ORIGINS: 'https://viewer.example',
  }))
  app.all('/resource', c => c.json({ ok: true }))

  assert.equal((await app.request('http://tokember.test/resource')).status, 200)
  const same = await app.request('http://tokember.test/resource', {
    headers: { Origin: 'http://tokember.test' },
  })
  assert.equal(same.status, 200)
  assert.equal(same.headers.get('access-control-allow-origin'), 'http://tokember.test')

  const allowed = await app.request('http://tokember.test/resource', {
    headers: { Origin: 'https://viewer.example' },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://viewer.example')
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true')
  assert.notEqual(allowed.headers.get('access-control-allow-origin'), '*')

  const rejected = await app.request('http://tokember.test/resource', {
    method: 'POST', headers: { Origin: 'https://evil.example' },
  })
  assert.equal(rejected.status, 403)
  const preflight = await app.request('http://tokember.test/resource', {
    method: 'OPTIONS', headers: {
      Origin: 'https://viewer.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  assert.equal(preflight.status, 204)
})

test('CORS stays exact when a trusted proxy omits forwarded origin headers', async () => {
  const app = new Hono()
  app.use('*', createCorsMiddleware({
    TOKEMBER_CORS_ORIGINS: 'https://tokember.example',
    TOKEMBER_TRUST_PROXY: 'true',
  }))
  app.get('/resource', c => c.json({ ok: true }))

  const allowed = await app.request('http://127.0.0.1:3147/resource', {
    headers: { Origin: 'https://tokember.example' },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://tokember.example')

  const rejected = await app.request('http://127.0.0.1:3147/resource', {
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(rejected.status, 403)
})

test('CORS uses overwritten forwarded host and proto only when proxy trust is enabled', async () => {
  const app = new Hono()
  app.use('*', createCorsMiddleware({ TOKEMBER_TRUST_PROXY: 'true' }))
  app.get('/resource', c => c.json({ ok: true }))

  const response = await app.request('http://127.0.0.1:3147/resource', {
    headers: {
      Origin: 'https://tokember.example',
      'X-Forwarded-Host': 'tokember.example',
      'X-Forwarded-Proto': 'https',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://tokember.example')
})

function runReport(deviceId: string) {
  return {
    schema_version: 1, run_id: `run-${deviceId}`, device_id: deviceId,
    collector_kind: 'native', collector_version: '0.1.0',
    schedule_interval_minutes: 30,
    started_at: '2026-07-18T00:00:00.000Z',
    finished_at: '2026-07-18T00:00:01.000Z',
    status: 'success', duration_ms: 1000, emitted: 0, accepted: 0, unchanged: 0,
    error_summary: null,
    sources: [{
      source: 'codex', status: 'success', discovered: 0, scanned: 0,
      emitted: 0, accepted: 0, unchanged: 0, watermark_at: null,
      last_usage_at: null, duration_ms: 900, error_summary: null,
    }],
  }
}

test('device credentials bind every collector boundary and revoke immediately', async () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?), (?, ?)')
    .run('d1', 'One', 'd2', 'Two')
  const env = securityEnv({ TOKEMBER_ALLOW_LEGACY_API_KEY: 'false' })
  const service = new DeviceCredentialService(db, env)
  const created = service.create({ device_id: 'd1', label: 'Primary' })!
  const headers = { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' }
  const app = apiRoutes(db, undefined, { env })

  const own = await app.request('/devices', {
    method: 'POST', headers, body: JSON.stringify({ id: 'd1', name: 'One' }),
  })
  assert.equal(own.status, 200)
  const other = await app.request('/devices', {
    method: 'POST', headers, body: JSON.stringify({ id: 'd2', name: 'Two' }),
  })
  assert.equal(other.status, 403)
  assert.equal((await app.request('/ingest', {
    method: 'POST', headers, body: JSON.stringify({ device_id: 'd2', records: [] }),
  })).status, 403)
  assert.equal((await app.request('/collector-runs', {
    method: 'POST', headers, body: JSON.stringify(runReport('d2')),
  })).status, 403)
  assert.equal((await app.request('/source-cutovers?device_id=d2&provider=claude', {
    headers,
  })).status, 403)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM collector_runs')
    .get() as { count: number }).count, 0)

  const rotated = service.rotate(created.credential.id)
  assert.notEqual(rotated, 'missing')
  assert.equal((await app.request('/devices', {
    method: 'POST', headers, body: JSON.stringify({ id: 'd1', name: 'One' }),
  })).status, 401)
  const newHeaders = {
    Authorization: `Bearer ${(rotated as { token: string }).token}`,
    'Content-Type': 'application/json',
  }
  assert.equal((await app.request('/devices', {
    method: 'POST', headers: newHeaders, body: JSON.stringify({ id: 'd1', name: 'One' }),
  })).status, 200)
  assert.equal(service.revoke((rotated as { credential: { id: number } }).credential.id), true)
  assert.equal((await app.request('/devices', {
    method: 'POST', headers: newHeaders, body: JSON.stringify({ id: 'd1', name: 'One' }),
  })).status, 401)
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM device_credentials').all()),
    new RegExp(created.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  db.close()
})

test('device token parsing stays unambiguous when Base64URL fields contain underscores', () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'One')
  const tokenId = `${'a'.repeat(7)}_${'b'.repeat(8)}`
  const secret = `${'c'.repeat(20)}_${'d'.repeat(22)}`
  db.prepare(`
    INSERT INTO device_credentials (token_id, device_id, label, secret_hash, created_at)
    VALUES (?, 'd1', 'Primary', ?, '2026-07-18T00:00:00.000Z')
  `).run(tokenId, createHash('sha256').update(secret).digest('hex'))
  const service = new DeviceCredentialService(db, securityEnv({
    TOKEMBER_ALLOW_LEGACY_API_KEY: 'false',
  }))
  assert.deepEqual(service.authenticate(`tkdc_${tokenId}_${secret}`), {
    kind: 'device', credentialId: 1, deviceId: 'd1',
  })
  db.close()
})

test('admin credential API provisions once and never lists the token', async () => {
  const db = initDB(':memory:')
  const env = securityEnv({ TOKEMBER_API_KEY: 'legacy-key' })
  const app = apiRoutes(db, undefined, { env })
  const adminCookie = cookieFrom(await login(app, '/admin/login', 'admin-password'))
  const created = await app.request('/admin/device-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ device_id: 'new-device', device_name: 'New Device', label: 'Primary' }),
  })
  assert.equal(created.status, 200)
  const body = await created.json() as { token: string }
  assert.match(body.token, /^tkdc_/)
  const listed = await app.request('/admin/device-credentials', {
    headers: { Cookie: adminCookie },
  })
  assert.equal(listed.status, 200)
  assert.doesNotMatch(JSON.stringify(await listed.json()), new RegExp(body.token))
  db.close()
})

test('legacy collector key remains explicit compatibility and can be disabled', async () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'One')
  const allowed = apiRoutes(db, undefined, { env: securityEnv({ TOKEMBER_API_KEY: 'legacy-key' }) })
  const request = {
    method: 'POST', headers: {
      Authorization: 'Bearer legacy-key', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ id: 'd1', name: 'One' }),
  }
  assert.equal((await allowed.request('/devices', request)).status, 200)
  const denied = apiRoutes(db, undefined, { env: securityEnv({
    TOKEMBER_API_KEY: 'legacy-key', TOKEMBER_ALLOW_LEGACY_API_KEY: 'false',
  }) })
  assert.equal((await denied.request('/devices', request)).status, 401)
  db.close()
})
