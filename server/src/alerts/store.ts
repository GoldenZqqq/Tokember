import type {
  AlertEvidence,
  AlertEvent,
  AlertRule,
  AlertRuleConfig,
  AlertRuleInput,
  AlertRuleWithEvaluation,
  AlertRuleEvaluation,
} from '@tokember/contracts/alerts'
import type { DB } from '../db.js'
import { decodeAlertRuleConfig } from './rule-codec.js'

interface RuleRow {
  id: number
  name: string
  kind: AlertRule['kind']
  device_id: string | null
  provider: string | null
  timezone: string
  config_json: string
  enabled: number
  cooldown_minutes: number
  notify_webhook: number
  created_at: string
  updated_at: string
}

interface EvaluationRow {
  rule_id: number
  evaluated_at: string
  status: AlertRuleEvaluation['status']
  reason: string
  evidence_json: string | null
}

interface EventRow extends Omit<AlertEvent, 'rule_name' | 'kind' | 'evidence'> {
  rule_name: string
  kind: AlertEvent['kind']
  evidence_json: string
}

function parseJson(value: string): unknown {
  return JSON.parse(value)
}

function rowToRule(row: RuleRow): AlertRule {
  const config = decodeAlertRuleConfig(row.kind, parseJson(row.config_json))
  return {
    id: row.id, name: row.name, kind: row.kind,
    device_id: row.device_id, provider: row.provider, timezone: row.timezone,
    config, enabled: row.enabled === 1,
    cooldown_minutes: row.cooldown_minutes,
    notify_webhook: row.notify_webhook === 1,
    created_at: row.created_at, updated_at: row.updated_at,
  } as AlertRule
}

function rowToEvaluation(row: EvaluationRow | undefined): AlertRuleEvaluation | null {
  if (!row) return null
  return {
    rule_id: row.rule_id, evaluated_at: row.evaluated_at,
    status: row.status, reason: row.reason,
    evidence: row.evidence_json ? parseJson(row.evidence_json) as AlertEvidence : null,
  }
}

export function listAlertRules(db: DB): AlertRule[] {
  const rows = db.prepare('SELECT * FROM alert_rules ORDER BY id').all() as RuleRow[]
  return rows.map(rowToRule)
}

export function getAlertRule(db: DB, id: number): AlertRule | null {
  const row = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleRow | undefined
  return row ? rowToRule(row) : null
}

function assertDeviceExists(db: DB, deviceId: string | null): void {
  if (!deviceId) return
  if (!db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)) {
    throw new AlertRuleStoreError('device_not_found')
  }
}

export class AlertRuleStoreError extends Error {
  constructor(readonly code: 'device_not_found' | 'rule_not_found') {
    super(code)
  }
}

export function createAlertRule(db: DB, input: AlertRuleInput): AlertRule {
  assertDeviceExists(db, input.device_id)
  const result = db.prepare(`
    INSERT INTO alert_rules
      (name, kind, device_id, provider, timezone, config_json,
       enabled, cooldown_minutes, notify_webhook)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name, input.kind, input.device_id, input.provider, input.timezone,
    JSON.stringify(input.config), Number(input.enabled), input.cooldown_minutes,
    Number(input.notify_webhook),
  )
  return getAlertRule(db, Number(result.lastInsertRowid))!
}

export function updateAlertRule(db: DB, id: number, input: AlertRuleInput): AlertRule {
  assertDeviceExists(db, input.device_id)
  const result = db.prepare(`
    UPDATE alert_rules SET name = ?, kind = ?, device_id = ?, provider = ?,
      timezone = ?, config_json = ?, enabled = ?, cooldown_minutes = ?,
      notify_webhook = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.name, input.kind, input.device_id, input.provider, input.timezone,
    JSON.stringify(input.config), Number(input.enabled), input.cooldown_minutes,
    Number(input.notify_webhook), id,
  )
  if (result.changes === 0) throw new AlertRuleStoreError('rule_not_found')
  if (!input.enabled) recoverRuleEvents(db, id, new Date().toISOString())
  return getAlertRule(db, id)!
}

export function setAlertRuleEnabled(db: DB, id: number, enabled: boolean, now: string): AlertRule {
  const result = db.prepare(`
    UPDATE alert_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?
  `).run(Number(enabled), id)
  if (result.changes === 0) throw new AlertRuleStoreError('rule_not_found')
  if (!enabled) recoverRuleEvents(db, id, now)
  return getAlertRule(db, id)!
}

export function recoverRuleEvents(db: DB, ruleId: number, now: string): void {
  db.prepare(`
    UPDATE alert_events SET status = 'recovered', recovered_at = ?,
      updated_at = datetime('now')
    WHERE rule_id = ? AND status = 'active'
  `).run(now, ruleId)
}

export function acknowledgeAlertEvent(db: DB, id: number, now: string): boolean {
  return db.prepare(`
    UPDATE alert_events SET acknowledged_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(now, id).changes > 0
}

export function listRulesWithEvaluations(db: DB): AlertRuleWithEvaluation[] {
  const rows = db.prepare('SELECT * FROM alert_rule_evaluations').all() as EvaluationRow[]
  const evaluations = new Map(rows.map(row => [row.rule_id, row]))
  return listAlertRules(db).map(rule => ({
    ...rule, evaluation: rowToEvaluation(evaluations.get(rule.id)),
  }))
}

export function listAlertEvents(db: DB, limit = 100): AlertEvent[] {
  const rows = db.prepare(`
    SELECT e.*, r.name AS rule_name, r.kind, r.device_id, r.provider
    FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
    ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.id DESC
    LIMIT ?
  `).all(limit) as EventRow[]
  return rows.map(row => ({
    id: row.id, rule_id: row.rule_id, rule_name: row.rule_name, kind: row.kind,
    device_id: row.device_id, provider: row.provider, dedup_key: row.dedup_key,
    status: row.status, severity: row.severity,
    first_triggered_at: row.first_triggered_at, last_triggered_at: row.last_triggered_at,
    recovered_at: row.recovered_at, acknowledged_at: row.acknowledged_at,
    cooldown_until: row.cooldown_until, notification_status: row.notification_status,
    evidence: parseJson(row.evidence_json) as AlertEvidence,
  }))
}

export function stringifyConfig(config: AlertRuleConfig): string {
  return JSON.stringify(config)
}
