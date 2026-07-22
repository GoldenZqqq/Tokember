import assert from 'node:assert/strict'
import test from 'node:test'
import { initDB } from './db.js'
import { apiRoutes } from './routes.js'

process.env.TOKEMBER_ADMIN_PASSWORD = 'development'

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie')
  assert.ok(header)
  return header.split(';')[0]
}

async function authenticatedHeaders(app: ReturnType<typeof apiRoutes>) {
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'development' }),
  })
  return { 'Content-Type': 'application/json', Cookie: cookieFrom(login) }
}

function budgetInput() {
  return {
    name: 'Daily budget', kind: 'budget', device_id: 'd1', provider: null,
    timezone: 'Asia/Shanghai', enabled: true, cooldown_minutes: 60,
    notify_webhook: true, config: { period: 'day', metric: 'cost', limit: 1 },
  }
}

function insertCurrentUsage(db: ReturnType<typeof initDB>): void {
  db.prepare(`
    INSERT INTO usage_records
      (device_id, provider, model, input_tokens, cost_usd, timestamp,
       dedup_key, pricing_status)
    VALUES ('d1', 'openai', 'model', 100, 1, ?, 'admin-alert', 'provided')
  `).run(new Date().toISOString())
}

function configureWebhook(): () => void {
  const previousUrl = process.env.TOKEMBER_ALERT_WEBHOOK_URL
  const previousSecret = process.env.TOKEMBER_ALERT_WEBHOOK_SECRET
  process.env.TOKEMBER_ALERT_WEBHOOK_URL = 'https://secret.example.test/hook'
  process.env.TOKEMBER_ALERT_WEBHOOK_SECRET = 'never-return-this-secret'
  return () => {
    if (previousUrl === undefined) delete process.env.TOKEMBER_ALERT_WEBHOOK_URL
    else process.env.TOKEMBER_ALERT_WEBHOOK_URL = previousUrl
    if (previousSecret === undefined) delete process.env.TOKEMBER_ALERT_WEBHOOK_SECRET
    else process.env.TOKEMBER_ALERT_WEBHOOK_SECRET = previousSecret
  }
}

test('admin alert center validates rules protects secrets and acknowledges events', async t => {
  t.after(configureWebhook())
  const db = initDB(':memory:')
  t.after(() => db.close())
  const app = apiRoutes(db)
  assert.equal((await app.request('/admin/alerts')).status, 401)
  const headers = await authenticatedHeaders(app)
  await app.request('/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', name: 'Device' }),
  })
  const input = budgetInput()
  const invalid = await app.request('/admin/alerts/rules', {
    method: 'POST', headers, body: JSON.stringify({
      ...input, config: { ...input.config, limit: 0 },
    }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json() as { field: string }).field, 'config.limit')
  const created = await app.request('/admin/alerts/rules', {
    method: 'POST', headers, body: JSON.stringify(input),
  })
  assert.equal(created.status, 201)
  const createdBody = await created.json() as { rule: { id: number } }
  insertCurrentUsage(db)
  const evaluated = await app.request('/admin/alerts/evaluate', {
    method: 'POST', headers,
  })
  const raw = await evaluated.text()
  assert.equal(evaluated.status, 200)
  assert.doesNotMatch(raw, /secret\.example|never-return-this-secret/)
  const center = JSON.parse(raw)
  assert.equal(center.webhook_configured, true)
  assert.ok(center.events.length >= 1)
  const acknowledged = await app.request(
    `/admin/alerts/events/${center.events[0].id}/acknowledge`,
    { method: 'POST', headers },
  )
  assert.equal(acknowledged.status, 200)
  const disabled = await app.request(
    `/admin/alerts/rules/${createdBody.rule.id}/enabled`,
    { method: 'POST', headers, body: JSON.stringify({ enabled: false }) },
  )
  assert.equal((await disabled.json() as { rule: { enabled: boolean } }).rule.enabled, false)
})
