import type { Context, Hono } from 'hono'
import type { AlertRuleInput } from '@tokember/contracts/alerts'
import type { DB } from '../db.js'
import { evaluateAlertCenter, getAlertCenter, getAlertRuleWithEvaluation } from './center.js'
import {
  AlertRuleValidationError,
  decodeAlertRuleInput,
} from './rule-codec.js'
import {
  acknowledgeAlertEvent,
  AlertRuleStoreError,
  createAlertRule,
  setAlertRuleEnabled,
  updateAlertRule,
} from './store.js'

function parseId(value: string): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function storeError(c: Context, error: unknown): Response {
  if (!(error instanceof AlertRuleStoreError)) throw error
  return error.code === 'device_not_found'
    ? c.json({ error: '设备不存在', code: error.code }, 404)
    : c.json({ error: '告警规则不存在', code: error.code }, 404)
}

async function ruleBody(c: Context): Promise<AlertRuleInput | Response> {
  try {
    return decodeAlertRuleInput(await c.req.json())
  } catch (error) {
    if (error instanceof AlertRuleValidationError) {
      return c.json({
        error: '告警规则参数无效', code: 'invalid_alert_rule', field: error.field,
      }, 400)
    }
    return c.json({ error: '请求 JSON 无效', code: 'invalid_json' }, 400)
  }
}

export function registerAlertRoutes(admin: Hono, db: DB): void {
  admin.get('/alerts', c => c.json(getAlertCenter(db)))
  admin.post('/alerts/rules', async c => {
    const input = await ruleBody(c)
    if (input instanceof Response) return input
    try {
      const rule = createAlertRule(db, input)
      return c.json({ rule: getAlertRuleWithEvaluation(db, rule.id) }, 201)
    } catch (error) {
      return storeError(c, error)
    }
  })
  admin.put('/alerts/rules/:id', async c => {
    const id = parseId(c.req.param('id'))
    if (!id) return c.json({ error: '告警规则 ID 无效', code: 'invalid_rule_id' }, 400)
    const input = await ruleBody(c)
    if (input instanceof Response) return input
    try {
      updateAlertRule(db, id, input)
      return c.json({ rule: getAlertRuleWithEvaluation(db, id) })
    } catch (error) {
      return storeError(c, error)
    }
  })
  admin.post('/alerts/rules/:id/enabled', async c => {
    const id = parseId(c.req.param('id'))
    const body = await c.req.json().catch(() => null)
    if (!id || typeof body?.enabled !== 'boolean') {
      return c.json({ error: '启停参数无效', code: 'invalid_enabled' }, 400)
    }
    try {
      setAlertRuleEnabled(db, id, body.enabled, new Date().toISOString())
      return c.json({ rule: getAlertRuleWithEvaluation(db, id) })
    } catch (error) {
      return storeError(c, error)
    }
  })
  admin.post('/alerts/events/:id/acknowledge', c => {
    const id = parseId(c.req.param('id'))
    if (!id) return c.json({ error: '告警事件 ID 无效', code: 'invalid_event_id' }, 400)
    return acknowledgeAlertEvent(db, id, new Date().toISOString())
      ? c.json({ ok: true })
      : c.json({ error: '告警事件不存在', code: 'event_not_found' }, 404)
  })
  admin.post('/alerts/evaluate', c => c.json(evaluateAlertCenter(db)))
}
