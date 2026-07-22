import assert from 'node:assert/strict'
import test from 'node:test'
import { initDB } from './db.js'
import { apiRoutes } from './routes.js'

process.env.TOKEMBER_ADMIN_PASSWORD = 'development'
delete process.env.TOKEMBER_API_KEY
delete process.env.AI_BURN_API_KEY
delete process.env.API_KEY

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie')
  assert.ok(header)
  return header.split(';')[0]
}

test('admin attribution routes require auth and merge only on explicit request', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  const projects = [`prj_v1_${'a'.repeat(43)}`, `prj_v1_${'b'.repeat(43)}`]
  for (const [index, device] of ['d1', 'd2'].entries()) {
    await app.request('/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: device, name: device }),
    })
    const ingested = await app.request('/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: device, records: [{
        provider: 'gemini', model: 'gemini-test', input_tokens: 10,
        output_tokens: 1, timestamp: new Date().toISOString(), dedup_key: `attr-${index}`,
        attribution_version: 1, attribution_status: 'captured', project_id: projects[index],
      }] }),
    })
    assert.equal(ingested.status, 200)
  }
  assert.equal((await app.request('/admin/attribution/projects')).status, 401)
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  const headers = { 'Content-Type': 'application/json', Cookie: cookieFrom(login) }
  const listed = await (await app.request('/admin/attribution/projects', { headers })).json() as {
    groups: Array<{ id: number; members: Array<{ device_id: string; project_id: string }> }>
  }
  assert.equal(listed.groups.length, 2)
  const target = listed.groups[0]!
  const source = listed.groups[1]!.members[0]!
  const merged = await app.request('/admin/attribution/projects/merge', {
    method: 'POST', headers, body: JSON.stringify({
      device_id: source.device_id, project_id: source.project_id,
      target_group_id: target.id,
    }),
  })
  assert.equal(merged.status, 200)
  const after = await (await app.request('/admin/attribution/projects', { headers })).json() as {
    groups: Array<{ members: unknown[] }>
  }
  assert.equal(after.groups.length, 1)
  assert.equal(after.groups[0]?.members.length, 2)
  assert.equal((db.prepare('SELECT COUNT(*) count FROM usage_records').get() as { count: number }).count, 2)
  db.close()
})
