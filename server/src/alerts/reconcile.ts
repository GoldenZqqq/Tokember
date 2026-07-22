import type {
  AlertNotificationStatus,
  AlertRuleEvaluation,
} from '@tokember/contracts/alerts'
import type { DB } from '../db.js'
import {
  evaluateEnabledAlertRules,
  type AlertObservation,
  type EvaluatedRule,
} from './evaluator.js'

interface ReconcileOptions {
  now: Date
  webhookConfigured: boolean
}

function notificationStatus(
  db: DB,
  evaluated: EvaluatedRule,
  observation: AlertObservation,
  options: ReconcileOptions,
): AlertNotificationStatus {
  if (!evaluated.rule.notify_webhook) return 'not_requested'
  if (!options.webhookConfigured) return 'not_configured'
  const previous = db.prepare(`
    SELECT cooldown_until FROM alert_events
    WHERE dedup_key = ? AND status = 'recovered'
    ORDER BY id DESC LIMIT 1
  `).get(observation.dedup_key) as { cooldown_until: string } | undefined
  return previous && previous.cooldown_until > options.now.toISOString() ? 'cooldown' : 'pending'
}

function saveEvaluation(db: DB, value: AlertRuleEvaluation): void {
  db.prepare(`
    INSERT INTO alert_rule_evaluations
      (rule_id, evaluated_at, status, reason, evidence_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      evaluated_at = excluded.evaluated_at, status = excluded.status,
      reason = excluded.reason, evidence_json = excluded.evidence_json
  `).run(
    value.rule_id, value.evaluated_at, value.status, value.reason,
    value.evidence ? JSON.stringify(value.evidence) : null,
  )
}

function insertObservation(
  db: DB,
  evaluated: EvaluatedRule,
  observation: AlertObservation,
  options: ReconcileOptions,
): void {
  const now = options.now.toISOString()
  const active = db.prepare(`
    SELECT id FROM alert_events WHERE dedup_key = ? AND status = 'active'
  `).get(observation.dedup_key) as { id: number } | undefined
  if (active) {
    db.prepare(`
      UPDATE alert_events SET last_triggered_at = ?, severity = ?,
        evidence_json = ?, updated_at = datetime('now') WHERE id = ?
    `).run(now, observation.severity, JSON.stringify(observation.evidence), active.id)
    return
  }
  const status = notificationStatus(db, evaluated, observation, options)
  const cooldown = new Date(options.now.getTime()
    + evaluated.rule.cooldown_minutes * 60_000).toISOString()
  const result = db.prepare(`
    INSERT INTO alert_events
      (rule_id, dedup_key, status, severity, first_triggered_at,
       last_triggered_at, cooldown_until, notification_status, evidence_json)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    evaluated.rule.id, observation.dedup_key, observation.severity,
    now, now, cooldown, status, JSON.stringify(observation.evidence),
  )
  if (status === 'pending') db.prepare(`
    INSERT INTO alert_webhook_deliveries (event_id, status, next_attempt_at)
    VALUES (?, 'pending', ?)
  `).run(result.lastInsertRowid, now)
}

function recoverMissing(db: DB, evaluated: EvaluatedRule, now: string): void {
  if (!evaluated.recover_missing) return
  const active = db.prepare(`
    SELECT id, dedup_key FROM alert_events
    WHERE rule_id = ? AND status = 'active'
  `).all(evaluated.rule.id) as Array<{ id: number; dedup_key: string }>
  const observed = new Set(evaluated.observations.map(item => item.dedup_key))
  const recover = db.prepare(`
    UPDATE alert_events SET status = 'recovered', recovered_at = ?,
      updated_at = datetime('now') WHERE id = ?
  `)
  for (const event of active) if (!observed.has(event.dedup_key)) recover.run(now, event.id)
}

export function reconcileAlertEvaluations(
  db: DB,
  evaluatedRules: EvaluatedRule[],
  options: ReconcileOptions,
): void {
  db.transaction(() => {
    for (const evaluated of evaluatedRules) {
      saveEvaluation(db, evaluated.evaluation)
      for (const observation of evaluated.observations) {
        insertObservation(db, evaluated, observation, options)
      }
      recoverMissing(db, evaluated, options.now.toISOString())
    }
  })()
}

export function runAlertEvaluation(
  db: DB,
  options: ReconcileOptions,
): EvaluatedRule[] {
  const evaluated = evaluateEnabledAlertRules(db, options.now)
  reconcileAlertEvaluations(db, evaluated, options)
  return evaluated
}
