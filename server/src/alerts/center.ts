import type {
  AlertCenterResponse,
  AlertEvaluationResponse,
  AlertRuleWithEvaluation,
} from '@tokember/contracts/alerts'
import type { DB } from '../db.js'
import { runAlertEvaluation } from './reconcile.js'
import {
  listAlertEvents,
  listRulesWithEvaluations,
} from './store.js'
import { readAlertWebhookConfig } from './webhook.js'

export function getAlertCenter(
  db: DB,
  env: NodeJS.ProcessEnv = process.env,
): AlertCenterResponse {
  return {
    webhook_configured: readAlertWebhookConfig(env) != null,
    rules: listRulesWithEvaluations(db),
    events: listAlertEvents(db),
  }
}

export function getAlertRuleWithEvaluation(db: DB, id: number): AlertRuleWithEvaluation | null {
  return listRulesWithEvaluations(db).find(rule => rule.id === id) ?? null
}

export function evaluateAlertCenter(
  db: DB,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): AlertEvaluationResponse {
  const configured = readAlertWebhookConfig(env) != null
  runAlertEvaluation(db, { now, webhookConfigured: configured })
  return { ...getAlertCenter(db, env), evaluated_at: now.toISOString() }
}
