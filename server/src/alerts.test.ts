import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database as DatabaseType } from 'better-sqlite3'
import { initDB } from './db.js'
import { completeLocalDayWindows, localPeriodWindow } from './alerts/calendar.js'
import { runAlertEvaluation } from './alerts/reconcile.js'
import { deliverDueAlertWebhooks } from './alerts/webhook.js'
import { createAlertWorker } from './alerts/worker.js'
import {
  AlertRuleValidationError,
  decodeAlertRuleInput,
} from './alerts/rule-codec.js'
import {
  acknowledgeAlertEvent,
  createAlertRule,
  listAlertEvents,
  listRulesWithEvaluations,
} from './alerts/store.js'

function budgetRule() {
  return {
    name: 'Daily budget', kind: 'budget', device_id: null, provider: null,
    timezone: 'Asia/Shanghai', enabled: true, cooldown_minutes: 60,
    notify_webhook: false,
    config: { period: 'day', metric: 'cost', limit: 10 },
  }
}

function alertDb(): DatabaseType {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  return db
}

let dedupSequence = 0

function insertUsage(
  db: DatabaseType,
  timestamp: string,
  tokens: number,
  cost: number,
  pricingStatus: 'provided' | 'unpriced' = 'provided',
): void {
  dedupSequence += 1
  db.prepare(`
    INSERT INTO usage_records
      (device_id, provider, model, input_tokens, cost_usd, timestamp,
       source_file, dedup_key, pricing_status)
    VALUES ('d1', 'openai', 'model', ?, ?, ?, 'test', ?, ?)
  `).run(tokens, cost, timestamp, `alert:${dedupSequence}`, pricingStatus)
}

test('alert rule decoder keeps kind config strict and rejects zero budgets', () => {
  assert.deepEqual(decodeAlertRuleInput(budgetRule()), budgetRule())
  assert.throws(() => decodeAlertRuleInput({
    ...budgetRule(), timezone: 'Not/A_Zone',
  }), (error: unknown) => (
    error instanceof AlertRuleValidationError && error.field === 'timezone'
  ))
  assert.throws(() => decodeAlertRuleInput({
    ...budgetRule(), config: { period: 'day', metric: 'cost', limit: 0 },
  }), (error: unknown) => (
    error instanceof AlertRuleValidationError && error.field === 'config.limit'
  ))
})

test('IANA day and month windows preserve DST and calendar boundaries', () => {
  const dstDay = localPeriodWindow(
    new Date('2026-03-08T16:00:00.000Z'), 'day', 'America/New_York',
  )
  assert.deepEqual(dstDay, {
    since: '2026-03-08T05:00:00.000Z',
    until: '2026-03-09T04:00:00.000Z',
  })
  const month = localPeriodWindow(
    new Date('2026-12-31T15:00:00.000Z'), 'month', 'Asia/Shanghai',
  )
  assert.deepEqual(month, {
    since: '2026-11-30T16:00:00.000Z',
    until: '2026-12-31T16:00:00.000Z',
  })
  const history = completeLocalDayWindows(
    new Date('2026-03-10T16:00:00.000Z'), 'America/New_York', 3,
  )
  assert.equal(Date.parse(history[1].until) - Date.parse(history[1].since), 23 * 60 * 60 * 1000)
  assert.equal(history[2].until, '2026-03-10T04:00:00.000Z')
})

test('budget events deduplicate recover acknowledge and restart in a new day', () => {
  const db = alertDb()
  insertUsage(db, '2026-07-17T02:00:00.000Z', 1000, 8)
  insertUsage(db, '2026-07-17T03:00:00.000Z', 500, 0, 'unpriced')
  const rule = createAlertRule(db, decodeAlertRuleInput(budgetRule()))
  const first = new Date('2026-07-17T04:00:00.000Z')
  runAlertEvaluation(db, { now: first, webhookConfigured: false })
  let events = listAlertEvents(db)
  assert.equal(events.filter(event => event.status === 'active').length, 2)
  assert.deepEqual(events.map(event => event.severity).sort(), ['info', 'warning'])
  const budgetEvidence = events[0].evidence
  assert.equal(budgetEvidence.kind, 'budget')
  if (budgetEvidence.kind === 'budget') assert.equal(budgetEvidence.forecast_incomplete, true)

  runAlertEvaluation(db, {
    now: new Date('2026-07-17T04:01:00.000Z'), webhookConfigured: false,
  })
  events = listAlertEvents(db)
  assert.equal(events.length, 2)
  assert.equal(acknowledgeAlertEvent(db, events[0].id, first.toISOString()), true)
  assert.equal(listAlertEvents(db)[0].status, 'active')

  runAlertEvaluation(db, {
    now: new Date('2026-07-18T04:00:00.000Z'), webhookConfigured: false,
  })
  assert.equal(listAlertEvents(db).filter(event => event.status === 'active').length, 0)
  insertUsage(db, '2026-07-18T02:00:00.000Z', 100, 6)
  runAlertEvaluation(db, {
    now: new Date('2026-07-18T04:01:00.000Z'), webhookConfigured: false,
  })
  events = listAlertEvents(db)
  assert.equal(events.filter(event => event.status === 'active').length, 1)
  assert.equal(events.length, 3)
  assert.equal(events.find(event => event.rule_id === rule.id)?.notification_status, 'not_requested')
  db.close()
})

test('spike reports insufficient history instead of inventing a baseline', () => {
  const db = alertDb()
  insertUsage(db, '2026-07-17T02:00:00.000Z', 100, 1)
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), name: 'Spike', kind: 'spike',
    config: { metric: 'tokens', multiplier: 2, baseline_days: 7, minimum_value: 1 },
  }))
  runAlertEvaluation(db, {
    now: new Date('2026-07-17T04:00:00.000Z'), webhookConfigured: false,
  })
  const [rule] = listRulesWithEvaluations(db)
  assert.equal(rule.evaluation?.status, 'insufficient_data')
  assert.match(rule.evaluation?.reason ?? '', /至少需要 3/)
  assert.equal(listAlertEvents(db).length, 0)
  db.close()
})

test('unpriced growth and consecutive source failures keep explainable evidence', () => {
  const db = alertDb()
  for (const day of [14, 15, 16]) {
    insertUsage(db, `2026-07-${day}T02:00:00.000Z`, 90, 1)
    insertUsage(db, `2026-07-${day}T03:00:00.000Z`, 10, 0, 'unpriced')
  }
  insertUsage(db, '2026-07-17T02:00:00.000Z', 50, 1)
  insertUsage(db, '2026-07-17T03:00:00.000Z', 50, 0, 'unpriced')
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), name: 'Unpriced', kind: 'unpriced_growth',
    config: { baseline_days: 3, increase_ratio: 0.2, minimum_current_ratio: 0.3 },
  }))
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), name: 'Gemini health', kind: 'source_health', provider: 'gemini',
    config: { consecutive_failures: 2, stale_minutes: 120 },
  }))
  insertFailedRuns(db)
  runAlertEvaluation(db, {
    now: new Date('2026-07-17T04:00:00.000Z'), webhookConfigured: false,
  })
  const events = listAlertEvents(db)
  assert.equal(events.length, 2)
  assert.deepEqual(events.map(event => event.evidence.kind).sort(), [
    'source_health', 'unpriced_growth',
  ])
  const source = events.find(event => event.evidence.kind === 'source_health')!
  if (source.evidence.kind === 'source_health') {
    assert.equal(source.evidence.consecutive_failures, 2)
    assert.equal(source.evidence.source, 'gemini')
  }
  db.close()
})

function insertFailedRuns(db: DatabaseType): void {
  for (const [index, finished] of [
    ['1', '2026-07-17T03:00:00.000Z'], ['2', '2026-07-17T03:30:00.000Z'],
  ]) {
    db.prepare(`
      INSERT INTO collector_runs
        (run_id, device_id, report_schema_version, collector_kind,
         collector_version, schedule_interval_minutes, started_at, finished_at,
         status, duration_ms, emitted, accepted, unchanged)
      VALUES (?, 'd1', 1, 'native', '0.1.0', 30, ?, ?, 'partial', 1000, 1, NULL, NULL)
    `).run(`run-${index}`, finished, finished)
    db.prepare(`
      INSERT INTO collector_source_runs
        (run_id, source, status, discovered, scanned, emitted,
         accepted, unchanged, duration_ms)
      VALUES (?, 'gemini', 'upload_failed', 1, 1, 1, NULL, NULL, 900)
    `).run(`run-${index}`)
  }
}

test('webhook outbox signs payload retries 5xx and records success', async () => {
  const db = alertDb()
  insertUsage(db, '2026-07-17T02:00:00.000Z', 100, 9)
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), notify_webhook: true,
  }))
  const now = new Date('2026-07-17T04:00:00.000Z')
  runAlertEvaluation(db, { now, webhookConfigured: true })
  let attempts = 0
  let firstBody = ''
  let firstSignature = ''
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1
    firstBody ||= String(init?.body ?? '')
    firstSignature ||= new Headers(init?.headers).get('X-Tokember-Signature') ?? ''
    return new Response(null, { status: attempts === 1 ? 500 : 204 })
  }
  const config = { url: 'https://alerts.example.test/hook', secret: 'test-secret' }
  assert.equal(await deliverDueAlertWebhooks(db, { now, config, fetcher }), 2)
  assert.doesNotMatch(firstBody, /test-secret|alerts\.example/)
  assert.match(firstSignature, /^sha256=[0-9a-f]{64}$/)
  let deliveries = db.prepare(`
    SELECT status, attempt_count, next_attempt_at
    FROM alert_webhook_deliveries ORDER BY id
  `).all() as Array<{ status: string; attempt_count: number; next_attempt_at: string }>
  assert.deepEqual(deliveries.map(item => item.status), ['pending', 'delivered'])
  assert.equal(deliveries[0].attempt_count, 1)
  const retryAt = new Date(deliveries[0].next_attempt_at)
  assert.equal(retryAt.getTime() - now.getTime(), 60_000)
  assert.equal(await deliverDueAlertWebhooks(db, {
    now: retryAt, config, fetcher,
  }), 1)
  deliveries = db.prepare(`
    SELECT status, attempt_count, next_attempt_at
    FROM alert_webhook_deliveries ORDER BY id
  `).all() as typeof deliveries
  assert.deepEqual(deliveries.map(item => item.status), ['delivered', 'delivered'])
  assert.equal(listAlertEvents(db).every(event => event.notification_status === 'delivered'), true)
  db.close()
})

test('webhook timeout and fifth retry fail safely without response details', async () => {
  const db = alertDb()
  insertUsage(db, '2026-07-17T02:00:00.000Z', 100, 6)
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), notify_webhook: true,
  }))
  const start = new Date('2026-07-17T04:00:00.000Z')
  runAlertEvaluation(db, { now: start, webhookConfigured: true })
  const config = { url: 'https://alerts.example.test/hook', secret: 'test-secret' }
  const timeoutFetcher = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('secret upstream body')))
    })
  await deliverDueAlertWebhooks(db, {
    now: start, config, fetcher: timeoutFetcher, timeoutMs: 1, limit: 1,
  })
  let row = db.prepare(`
    SELECT * FROM alert_webhook_deliveries ORDER BY id LIMIT 1
  `).get() as { status: string; next_attempt_at: string; last_error_code: string }
  assert.equal(row.last_error_code, 'timeout')
  const alwaysFail = async () => new Response('sensitive response', { status: 503 })
  for (let attempt = 1; attempt < 5; attempt += 1) {
    await deliverDueAlertWebhooks(db, {
      now: new Date(row.next_attempt_at), config, fetcher: alwaysFail, limit: 1,
    })
    row = db.prepare(`
      SELECT * FROM alert_webhook_deliveries ORDER BY id LIMIT 1
    `).get() as typeof row
  }
  assert.equal(row.status, 'failed')
  assert.equal(row.last_error_code, 'http_503')
  assert.doesNotMatch(JSON.stringify(row), /sensitive response|test-secret/)
  db.close()
})

test('webhook retries 429 but finishes non-retryable 4xx immediately', async () => {
  const db = alertDb()
  insertUsage(db, '2026-07-17T02:00:00.000Z', 100, 9)
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), notify_webhook: true,
  }))
  const now = new Date('2026-07-17T04:00:00.000Z')
  runAlertEvaluation(db, { now, webhookConfigured: true })
  let calls = 0
  await deliverDueAlertWebhooks(db, {
    now, config: { url: 'https://alerts.example.test', secret: 'secret' },
    fetcher: async () => new Response(null, { status: ++calls === 1 ? 429 : 400 }),
  })
  const rows = db.prepare(`
    SELECT status, attempt_count, last_error_code
    FROM alert_webhook_deliveries ORDER BY id
  `).all()
  assert.deepEqual(rows, [
    { status: 'pending', attempt_count: 1, last_error_code: 'http_429' },
    { status: 'failed', attempt_count: 1, last_error_code: 'http_400' },
  ])
  db.close()
})

test('background alert worker rejects overlapping runs', async () => {
  const db = alertDb()
  insertUsage(db, '2026-07-17T02:00:00.000Z', 100, 6)
  createAlertRule(db, decodeAlertRuleInput({
    ...budgetRule(), notify_webhook: true,
  }))
  let resolveFetch: ((value: Response) => void) | undefined
  const worker = createAlertWorker(db, {
    env: {
      TOKEMBER_ALERT_WEBHOOK_URL: 'https://alerts.example.test',
      TOKEMBER_ALERT_WEBHOOK_SECRET: 'secret',
    },
    now: () => new Date('2026-07-17T04:00:00.000Z'),
    fetcher: () => new Promise(resolve => { resolveFetch = resolve }),
  })
  const first = worker.runOnce()
  assert.equal(await worker.runOnce(), false)
  while (!resolveFetch) await new Promise(resolve => setImmediate(resolve))
  resolveFetch(new Response(null, { status: 204 }))
  assert.equal(await first, true)
  assert.equal(listAlertEvents(db)[0].notification_status, 'delivered')
  db.close()
})
