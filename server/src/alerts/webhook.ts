import { createHmac } from 'node:crypto'
import type { AlertEvidence, AlertRuleKind, AlertSeverity } from '@tokember/contracts/alerts'
import type { DB } from '../db.js'

export interface AlertWebhookConfig {
  url: string
  secret: string
}

export type AlertWebhookFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface DueDelivery {
  id: number
  event_id: number
  attempt_count: number
  rule_id: number
  rule_name: string
  kind: AlertRuleKind
  device_id: string | null
  provider: string | null
  severity: AlertSeverity
  first_triggered_at: string
  last_triggered_at: string
  evidence_json: string
}

interface DeliveryOptions {
  now: Date
  config: AlertWebhookConfig
  fetcher?: AlertWebhookFetcher
  timeoutMs?: number
  limit?: number
}

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000]
const MAX_ATTEMPTS = 5

export function readAlertWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): AlertWebhookConfig | null {
  const rawUrl = (env.TOKEMBER_ALERT_WEBHOOK_URL ?? '').trim()
  const secret = (env.TOKEMBER_ALERT_WEBHOOK_SECRET ?? '').trim()
  if (!rawUrl || !secret) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return { url: url.toString(), secret }
  } catch {
    return null
  }
}

function payload(delivery: DueDelivery): string {
  return JSON.stringify({
    schema_version: 1,
    event: {
      id: delivery.event_id, rule_id: delivery.rule_id,
      rule_name: delivery.rule_name, kind: delivery.kind,
      severity: delivery.severity, device_id: delivery.device_id,
      provider: delivery.provider,
      first_triggered_at: delivery.first_triggered_at,
      last_triggered_at: delivery.last_triggered_at,
      evidence: JSON.parse(delivery.evidence_json) as AlertEvidence,
    },
  })
}

function signature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function postDelivery(
  delivery: DueDelivery,
  options: DeliveryOptions,
): Promise<{ delivered: boolean; retryable: boolean; code: string }> {
  const body = payload(delivery)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  try {
    const response = await (options.fetcher ?? fetch)(options.config.url, {
      method: 'POST', body, signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Tokember-Event': String(delivery.event_id),
        'X-Tokember-Signature': signature(body, options.config.secret),
      },
    })
    if (response.ok) return { delivered: true, retryable: false, code: 'delivered' }
    return {
      delivered: false,
      retryable: response.status === 429 || response.status >= 500,
      code: `http_${response.status}`,
    }
  } catch (error) {
    return {
      delivered: false, retryable: true,
      code: controller.signal.aborted ? 'timeout' : 'network_error',
    }
  } finally {
    clearTimeout(timeout)
  }
}

function dueDeliveries(db: DB, now: string, limit: number): DueDelivery[] {
  return db.prepare(`
    SELECT d.id, d.event_id, d.attempt_count,
      e.rule_id, r.name AS rule_name, r.kind, r.device_id, r.provider,
      e.severity, e.first_triggered_at, e.last_triggered_at, e.evidence_json
    FROM alert_webhook_deliveries d
    JOIN alert_events e ON e.id = d.event_id
    JOIN alert_rules r ON r.id = e.rule_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= ?
    ORDER BY d.next_attempt_at, d.id LIMIT ?
  `).all(now, limit) as DueDelivery[]
}

function markDelivered(db: DB, delivery: DueDelivery, now: string): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE alert_webhook_deliveries SET status = 'delivered',
        attempt_count = ?, last_attempt_at = ?, delivered_at = ?,
        last_error_code = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(delivery.attempt_count + 1, now, now, delivery.id)
    db.prepare(`
      UPDATE alert_events SET notification_status = 'delivered',
        updated_at = datetime('now') WHERE id = ?
    `).run(delivery.event_id)
  })()
}

function markFailed(
  db: DB,
  delivery: DueDelivery,
  result: { retryable: boolean; code: string },
  now: Date,
): void {
  const attempts = delivery.attempt_count + 1
  const retry = result.retryable && attempts < MAX_ATTEMPTS
  const next = retry
    ? new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]).toISOString()
    : now.toISOString()
  db.transaction(() => {
    db.prepare(`
      UPDATE alert_webhook_deliveries SET status = ?, attempt_count = ?,
        next_attempt_at = ?, last_attempt_at = ?, last_error_code = ?,
        updated_at = datetime('now') WHERE id = ?
    `).run(
      retry ? 'pending' : 'failed', attempts, next,
      now.toISOString(), result.code, delivery.id,
    )
    if (!retry) db.prepare(`
      UPDATE alert_events SET notification_status = 'failed',
        updated_at = datetime('now') WHERE id = ?
    `).run(delivery.event_id)
  })()
}

export async function deliverDueAlertWebhooks(
  db: DB,
  options: DeliveryOptions,
): Promise<number> {
  const deliveries = dueDeliveries(db, options.now.toISOString(), options.limit ?? 10)
  for (const delivery of deliveries) {
    const result = await postDelivery(delivery, options)
    if (result.delivered) markDelivered(db, delivery, options.now.toISOString())
    else markFailed(db, delivery, result, options.now)
  }
  return deliveries.length
}
