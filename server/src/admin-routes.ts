import { Hono } from 'hono'
import type { BuildInfo } from '@tokember/contracts/release'
import { resolveDbPath, type DB } from './db.js'
import {
  DEFAULT_IGNORE_PATTERN,
  classifyModelAlias,
  getMaintenanceSummary,
  ignoreUnpricedByPattern,
  listPricingRules,
  PRICING_MODES,
  repriceUnpricedRecords,
  restoreIgnoredByPattern,
  sanitizeIgnorePattern,
  type PricingMode,
} from './pricing.js'
import { getSystemInfo } from './system-info.js'
import { normalizeModel } from './model-normalize.js'
import { emptyCollectorHealth, getCollectorHealthMap } from './collector-health.js'
import {
  parseCutoverAt,
  parseSourceProvider,
  setSourceCutoverByAdmin,
} from './source-authority.js'
import { registerAuditRoutes } from './audit-routes.js'
import { registerAlertRoutes } from './alerts/routes.js'
import { registerAttributionRoutes } from './attribution-routes.js'
import type { DeviceCredentialService } from './security/device-credentials.js'
import type { LoginService } from './security/login.js'
import { registerDeviceCredentialAdminRoutes } from './security/routes.js'
import type { SessionService } from './security/session.js'

interface RuleInput {
  source: string | null
  model: string
  mode: PricingMode
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  enabled: number
}

function parseNonNegative(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseRuleInput(raw: any): RuleInput | null {
  const source = raw?.source == null
    ? null
    : typeof raw.source === 'string' ? raw.source.trim() || null : undefined
  const model = typeof raw?.model === 'string' ? normalizeModel(raw.model.trim()) : ''
  const mode = raw?.mode as PricingMode
  const prices = [raw?.input_price, raw?.output_price, raw?.cache_read_price, raw?.cache_write_price]
    .map(parseNonNegative)
  if (source === undefined || !model || !PRICING_MODES.includes(mode) || prices.some(v => v == null)) return null
  return {
    source, model, mode,
    input_price: prices[0]!, output_price: prices[1]!,
    cache_read_price: prices[2]!, cache_write_price: prices[3]!,
    enabled: raw?.enabled === false || raw?.enabled === 0 ? 0 : 1,
  }
}

function uniqueConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

function parseAliasInput(raw: any): { source: string; alias: string } | null {
  const source = typeof raw?.source === 'string' ? raw.source.trim() : ''
  const alias = typeof raw?.alias === 'string' ? raw.alias.trim() : ''
  if (!source || !alias || source.length > 120 || alias.length > 240) return null
  return { source, alias }
}

function ruleWithAliases(db: DB, id: number) {
  return listPricingRules(db).find(rule => rule.id === id)
}

interface AdminSecurityServices {
  sessions: SessionService
  login: LoginService
  credentials: DeviceCredentialService
}

export function adminRoutes(
  db: DB,
  dbPath: string | undefined,
  buildInfo: BuildInfo | undefined,
  security: AdminSecurityServices,
) {
  const admin = new Hono()
  const requireAdmin = security.sessions.requireAdmin()

  admin.post('/login', c => security.login.login('admin', c))

  admin.get('/session', c => c.json({
    authenticated: security.sessions.authenticated('admin', c),
  }))
  admin.post('/logout', c => {
    security.sessions.logout('admin', c)
    return c.json({ authenticated: false })
  })

  admin.use('/pricing/*', requireAdmin)
  admin.use('/maintenance/*', requireAdmin)
  admin.use('/system', requireAdmin)
  admin.use('/devices', requireAdmin)
  admin.use('/source-cutovers', requireAdmin)
  admin.use('/audit/*', requireAdmin)
  admin.use('/alerts', requireAdmin)
  admin.use('/alerts/*', requireAdmin)
  admin.use('/device-credentials', requireAdmin)
  admin.use('/device-credentials/*', requireAdmin)
  admin.use('/attribution/*', requireAdmin)

  registerAuditRoutes(admin, db)
  registerAlertRoutes(admin, db)
  registerDeviceCredentialAdminRoutes(admin, security.credentials)
  registerAttributionRoutes(admin, db)

  admin.get('/system', c => {
    const path = resolveDbPath(dbPath || process.env.DB_PATH)
    return c.json(getSystemInfo(db, path, buildInfo))
  })

  admin.get('/devices', c => {
    const rows = db.prepare(`
      SELECT
        d.id,
        d.name,
        d.created_at,
        d.last_seen_at,
        d.prev_seen_at,
        d.platform,
        d.architecture,
        d.hostname,
        (SELECT COUNT(*) FROM usage_records WHERE device_id = d.id) AS record_count,
        (SELECT MAX(timestamp) FROM usage_records WHERE device_id = d.id) AS last_record_at
      FROM devices d
      ORDER BY d.last_seen_at DESC NULLS LAST, d.name
    `).all() as Array<Record<string, unknown> & { id: string }>
    const health = getCollectorHealthMap(db)
    const devices = rows.map(device => ({
      ...device,
      collector: health.get(device.id) ?? emptyCollectorHealth(),
    }))
    return c.json({ devices })
  })

  admin.get('/source-cutovers', c => {
    const cutovers = db.prepare(`
      SELECT c.*, d.name AS device_name
      FROM source_cutovers c JOIN devices d ON d.id = c.device_id
      ORDER BY d.name, c.provider
    `).all()
    const events = db.prepare(`
      SELECT * FROM source_cutover_events ORDER BY id DESC LIMIT 100
    `).all()
    return c.json({ cutovers, events })
  })

  admin.put('/source-cutovers', async c => {
    const body = await c.req.json().catch(() => null)
    const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
    const provider = parseSourceProvider(body?.provider)
    const cutoverAt = body?.cutover_at === null ? null : parseCutoverAt(body?.cutover_at)
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (!deviceId || !provider || (body?.cutover_at !== null && !cutoverAt)
      || !reason || reason.length > 500) {
      return c.json({ error: 'device_id, provider, cutover_at and reason are required' }, 400)
    }
    const result = setSourceCutoverByAdmin(db, deviceId, provider, cutoverAt, reason)
    if (result === 'missing-device') return c.json({ error: 'device not found' }, 404)
    return c.json({ ok: true, changed: result === 'updated' })
  })

  admin.get('/pricing/rules', c => {
    return c.json({ rules: listPricingRules(db) })
  })

  admin.post('/pricing/rules', async c => {
    const input = parseRuleInput(await c.req.json().catch(() => null))
    if (!input) return c.json({ error: '价格规则参数无效' }, 400)
    try {
      const result = db.prepare(`
        INSERT INTO pricing_rules
          (source, model, mode, input_price, output_price,
           cache_read_price, cache_write_price, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.source, input.model, input.mode, input.input_price,
        input.output_price, input.cache_read_price, input.cache_write_price, input.enabled)
      const rule = ruleWithAliases(db, Number(result.lastInsertRowid))
      return c.json({ rule }, 201)
    } catch (error) {
      if (uniqueConflict(error)) return c.json({ error: '该模型在此规则范围内已存在' }, 409)
      throw error
    }
  })

  admin.put('/pricing/rules/:id', async c => {
    const id = Number(c.req.param('id'))
    const input = parseRuleInput(await c.req.json().catch(() => null))
    if (!Number.isInteger(id) || !input) return c.json({ error: '价格规则参数无效' }, 400)
    if (input.source != null) {
      const incompatible = db.prepare(`
        SELECT 1 FROM model_aliases
        WHERE pricing_rule_id = ? AND source <> ? LIMIT 1
      `).get(id, input.source)
      if (incompatible) return c.json({ error: '请先移除与新来源不兼容的模型别名' }, 409)
    }
    try {
      const result = db.prepare(`
        UPDATE pricing_rules SET source = ?, model = ?, mode = ?,
          input_price = ?, output_price = ?, cache_read_price = ?,
          cache_write_price = ?, enabled = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(input.source, input.model, input.mode, input.input_price,
        input.output_price, input.cache_read_price, input.cache_write_price, input.enabled, id)
      if (result.changes === 0) return c.json({ error: '价格规则不存在' }, 404)
      return c.json({ rule: ruleWithAliases(db, id) })
    } catch (error) {
      if (uniqueConflict(error)) return c.json({ error: '该模型在此规则范围内已存在' }, 409)
      throw error
    }
  })

  admin.delete('/pricing/rules/:id', c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: '规则 ID 无效' }, 400)
    const result = db.prepare('DELETE FROM pricing_rules WHERE id = ?').run(id)
    return result.changes > 0 ? c.json({ ok: true }) : c.json({ error: '价格规则不存在' }, 404)
  })

  admin.post('/pricing/rules/:id/aliases', async c => {
    const id = Number(c.req.param('id'))
    const input = parseAliasInput(await c.req.json().catch(() => null))
    if (!Number.isInteger(id) || !input) return c.json({ error: '模型别名参数无效' }, 400)
    const result = classifyModelAlias(db, input.source, input.alias, id)
    if (typeof result !== 'string') return c.json(result, 201)
    if (result === 'missing-rule') return c.json({ error: '计价规则不存在' }, 404)
    if (result === 'alias-conflict') return c.json({ error: '该来源的别名已归入其他模型' }, 409)
    if (result === 'disabled-rule') return c.json({ error: '不能归入已停用的计价规则' }, 409)
    if (result === 'incompatible-source') return c.json({ error: '别名来源与计价规则来源不兼容' }, 400)
    return c.json({ error: '别名与标准模型相同，无需归类' }, 400)
  })

  admin.delete('/pricing/aliases/:id', c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: '别名 ID 无效' }, 400)
    const result = db.prepare('DELETE FROM model_aliases WHERE id = ?').run(id)
    return result.changes > 0 ? c.json({ ok: true }) : c.json({ error: '模型别名不存在' }, 404)
  })

  admin.post('/pricing/reprice', async c => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(repriceUnpricedRecords(db, body.apply === true))
  })

  admin.get('/maintenance/summary', c => {
    const raw = c.req.query('pattern')
    const pattern = raw == null || raw === ''
      ? DEFAULT_IGNORE_PATTERN
      : sanitizeIgnorePattern(raw)
    if (!pattern) return c.json({ error: '忽略模式无效' }, 400)
    return c.json(getMaintenanceSummary(db, pattern))
  })

  admin.post('/maintenance/ignore', async c => {
    const body = await c.req.json().catch(() => ({})) as { pattern?: unknown }
    const pattern = body.pattern == null || body.pattern === ''
      ? DEFAULT_IGNORE_PATTERN
      : sanitizeIgnorePattern(body.pattern)
    if (!pattern) return c.json({ error: '忽略模式无效' }, 400)
    return c.json(ignoreUnpricedByPattern(db, pattern))
  })

  admin.post('/maintenance/restore', async c => {
    const body = await c.req.json().catch(() => ({})) as { pattern?: unknown; all?: unknown }
    if (body.all === true) return c.json(restoreIgnoredByPattern(db, null))
    const pattern = body.pattern == null || body.pattern === ''
      ? DEFAULT_IGNORE_PATTERN
      : sanitizeIgnorePattern(body.pattern)
    if (!pattern) return c.json({ error: '忽略模式无效' }, 400)
    return c.json(restoreIgnoredByPattern(db, pattern))
  })

  admin.post('/maintenance/classify-model', async c => {
    const body = await c.req.json().catch(() => null)
    const input = parseAliasInput(body)
    const ruleId = Number(body?.pricing_rule_id)
    if (!input || !Number.isInteger(ruleId)) return c.json({ error: '归类参数无效' }, 400)
    const result = classifyModelAlias(db, input.source, input.alias, ruleId)
    if (typeof result !== 'string') return c.json(result)
    if (result === 'missing-rule') return c.json({ error: '计价规则不存在' }, 404)
    if (result === 'alias-conflict') return c.json({ error: '该来源的模型已归入其他规则' }, 409)
    if (result === 'disabled-rule') return c.json({ error: '目标计价规则已停用' }, 409)
    if (result === 'incompatible-source') return c.json({ error: '目标规则不适用于该来源' }, 400)
    return c.json({ error: '该模型已经是目标标准模型' }, 400)
  })

  return admin
}
