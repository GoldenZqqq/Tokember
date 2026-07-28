import type { DB } from './db.js'
import { normalizeUsageMetrics } from './usage-metrics.js'

export const PRICING_MODES = ['priced', 'free', 'included'] as const
export type PricingMode = typeof PRICING_MODES[number]

export interface PricingRule {
  id: number
  source: string | null
  model: string
  mode: PricingMode
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  enabled: number
  /** `builtin` rows come from the shipped catalog; `user` rows are operator-owned. */
  origin: 'builtin' | 'user'
  /** Set once an admin edits the rule, which freezes it against catalog updates. */
  user_modified: number
  created_at: string
  updated_at: string
}

export interface ModelAlias {
  id: number
  pricing_rule_id: number
  source: string
  alias: string
  created_at: string
}

export interface PricingRuleWithAliases extends PricingRule {
  aliases: ModelAlias[]
}

export interface UsageForPricing {
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  reasoning_tokens?: number
  input_includes_cache_read?: boolean | number
  input_includes_cache_creation?: boolean | number
  output_includes_reasoning?: boolean | number
  cost_usd?: number
  cost_provided?: boolean
}

export interface PricingResult {
  cost_usd: number
  pricing_status: 'provided' | 'priced' | 'free' | 'included' | 'unpriced' | 'none' | 'ignored'
  pricing_rule_id: number | null
  pricing_source: string | null
}

export function calculateRuleCost(rule: PricingRule, usage: UsageForPricing): number {
  if (rule.mode !== 'priced') return 0
  const metrics = normalizeUsageMetrics(usage)
  const total = metrics.fresh_input_tokens * rule.input_price
    + metrics.billable_output_tokens * rule.output_price
    + metrics.cache_read_tokens * rule.cache_read_price
    + metrics.cache_creation_tokens * rule.cache_write_price
  return total / 1_000_000
}

export function findPricingRule(db: DB, source: string, model: string): PricingRule | undefined {
  return db.prepare(`
    SELECT * FROM pricing_rules
    WHERE model = ? AND enabled = 1 AND (source = ? OR source IS NULL)
    ORDER BY CASE WHEN source = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(model, source, source) as PricingRule | undefined
}

interface PricingRuleOptions {
  global?: PricingRule
  bySource: Map<string, PricingRule>
}

function loadPricingRuleLookup(db: DB): (source: string, model: string) => PricingRule | undefined {
  const rules = db.prepare(`
    SELECT * FROM pricing_rules WHERE enabled = 1
  `).all() as PricingRule[]
  const byModel = new Map<string, PricingRuleOptions>()
  for (const rule of rules) {
    const options: PricingRuleOptions = byModel.get(rule.model) ?? {
      bySource: new Map<string, PricingRule>(),
    }
    if (rule.source == null) options.global = rule
    else options.bySource.set(rule.source, rule)
    byModel.set(rule.model, options)
  }
  return (source, model) => {
    const options = byModel.get(model)
    return options?.bySource.get(source) ?? options?.global
  }
}

export function listPricingRules(db: DB): PricingRuleWithAliases[] {
  const rules = db.prepare(`
    SELECT * FROM pricing_rules ORDER BY model, source IS NOT NULL, source
  `).all() as PricingRule[]
  const aliases = db.prepare(`
    SELECT * FROM model_aliases ORDER BY source, alias
  `).all() as ModelAlias[]
  const byRule = new Map<number, ModelAlias[]>()
  for (const alias of aliases) {
    byRule.set(alias.pricing_rule_id, [
      ...(byRule.get(alias.pricing_rule_id) ?? []), alias,
    ])
  }
  return rules.map(rule => ({ ...rule, aliases: byRule.get(rule.id) ?? [] }))
}

export function getPricingRule(db: DB, id: number): PricingRule | undefined {
  return db.prepare('SELECT * FROM pricing_rules WHERE id = ?')
    .get(id) as PricingRule | undefined
}

function resolveWithoutRule(usage: UsageForPricing): PricingResult | null {
  const provided = Number(usage.cost_usd) || 0
  if (usage.cost_provided === true || provided > 0) {
    return { cost_usd: provided, pricing_status: 'provided', pricing_rule_id: null, pricing_source: 'collector' }
  }
  if (normalizeUsageMetrics(usage).real_total_tokens === 0) {
    return { cost_usd: 0, pricing_status: 'none', pricing_rule_id: null, pricing_source: null }
  }
  return null
}

function pricingFromRule(
  usage: UsageForPricing,
  rule: PricingRule | undefined,
): PricingResult {
  if (!rule) {
    return { cost_usd: 0, pricing_status: 'unpriced', pricing_rule_id: null, pricing_source: null }
  }
  return {
    cost_usd: calculateRuleCost(rule, usage),
    pricing_status: rule.mode,
    pricing_rule_id: rule.id,
    pricing_source: `rule:${rule.id}`,
  }
}

export function resolvePricing(db: DB, usage: UsageForPricing): PricingResult {
  const resolved = resolveWithoutRule(usage)
  if (resolved) return resolved
  const rule = findPricingRule(db, usage.provider, usage.model)
  return pricingFromRule(usage, rule)
}

interface UnpricedRow extends UsageForPricing { id: number }

export interface RepriceResult {
  matched: number
  cost_delta: number
  applied: boolean
}

export function repriceUnpricedRecords(db: DB, apply: boolean): RepriceResult {
  const rows = db.prepare(`
    SELECT id, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, reasoning_tokens,
           input_includes_cache_read, input_includes_cache_creation,
           output_includes_reasoning, cost_usd
    FROM usage_records WHERE pricing_status = 'unpriced'
  `).all() as UnpricedRow[]
  if (rows.length === 0) return { matched: 0, cost_delta: 0, applied: apply }
  const findRule = loadPricingRuleLookup(db)
  const updates = rows.map(row => {
    const pricing = resolveWithoutRule(row)
      ?? pricingFromRule(row, findRule(row.provider, row.model))
    return { row, pricing }
  })
    .filter(item => item.pricing.pricing_status !== 'unpriced')
  const costDelta = updates.reduce((sum, item) => sum + item.pricing.cost_usd, 0)

  if (apply) {
    const update = db.prepare(`
      UPDATE usage_records SET cost_usd = ?, pricing_status = ?,
        pricing_rule_id = ?, pricing_source = ? WHERE id = ?
    `)
    db.transaction(() => {
      for (const item of updates) {
        const p = item.pricing
        update.run(p.cost_usd, p.pricing_status, p.pricing_rule_id, p.pricing_source, item.row.id)
      }
    })()
  }
  return { matched: updates.length, cost_delta: costDelta, applied: apply }
}

export const DEFAULT_IGNORE_PATTERN = 'MODEL_PLACEHOLDER_*'

export interface MaintenanceModelCount {
  model: string
  provider: string
  count: number
}

export interface MaintenanceSummary {
  unpriced_count: number
  ignored_count: number
  placeholder_unpriced_count: number
  by_model: MaintenanceModelCount[]
  reprice: RepriceResult
  default_pattern: string
}

export interface MaintenanceActionResult {
  affected: number
  pattern: string
}

export interface ClassifyModelResult {
  affected: number
  repriced: number
  cost_delta: number
  source: string
  alias: string
  model: string
}

interface ClassifiableRow extends UsageForPricing {
  id: number
  pricing_status: PricingResult['pricing_status']
}

export type AliasTargetError = 'missing-rule' | 'disabled-rule'
  | 'incompatible-source' | 'same-model' | 'alias-conflict'

export function validateAliasTarget(
  db: DB,
  ruleId: number,
  source: string,
  alias: string,
): PricingRule | AliasTargetError {
  const rule = getPricingRule(db, ruleId)
  if (!rule) return 'missing-rule'
  if (!rule.enabled) return 'disabled-rule'
  if (rule.source != null && rule.source !== source) return 'incompatible-source'
  if (rule.model === alias) return 'same-model'
  const existing = db.prepare(`
    SELECT pricing_rule_id FROM model_aliases WHERE source = ? AND alias = ?
  `).get(source, alias) as { pricing_rule_id: number } | undefined
  if (existing && existing.pricing_rule_id !== ruleId) return 'alias-conflict'
  return rule
}

function classifyRows(
  db: DB,
  rows: ClassifiableRow[],
  canonicalModel: string,
): Pick<ClassifyModelResult, 'affected' | 'repriced' | 'cost_delta'> {
  const rename = db.prepare('UPDATE usage_records SET model = ? WHERE id = ?')
  const reprice = db.prepare(`
    UPDATE usage_records SET model = ?, cost_usd = ?, pricing_status = ?,
      pricing_rule_id = ?, pricing_source = ? WHERE id = ?
  `)
  let repriced = 0
  let costDelta = 0
  for (const row of rows) {
    if (row.pricing_status !== 'unpriced') {
      rename.run(canonicalModel, row.id)
      continue
    }
    const pricing = resolvePricing(db, { ...row, model: canonicalModel, cost_usd: 0 })
    reprice.run(canonicalModel, pricing.cost_usd, pricing.pricing_status,
      pricing.pricing_rule_id, pricing.pricing_source, row.id)
    if (pricing.pricing_status !== 'unpriced') repriced++
    costDelta += pricing.cost_usd - Number(row.cost_usd || 0)
  }
  return { affected: rows.length, repriced, cost_delta: costDelta }
}

export function classifyModelAlias(
  db: DB,
  source: string,
  alias: string,
  ruleId: number,
): ClassifyModelResult | AliasTargetError {
  const target = validateAliasTarget(db, ruleId, source, alias)
  if (typeof target === 'string') return target

  return db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO model_aliases (pricing_rule_id, source, alias)
      VALUES (?, ?, ?)
    `).run(ruleId, source, alias)
    const rows = db.prepare(`
      SELECT id, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, reasoning_tokens,
        input_includes_cache_read, input_includes_cache_creation,
        output_includes_reasoning, cost_usd, pricing_status
      FROM usage_records WHERE provider = ? AND model = ?
    `).all(source, alias) as ClassifiableRow[]
    return {
      ...classifyRows(db, rows, target.model),
      source, alias, model: target.model,
    }
  })()
}

/** Allow only simple GLOB patterns used for maintenance bulk actions. */
export function sanitizeIgnorePattern(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const pattern = value.trim()
  if (!pattern || pattern.length > 120) return null
  if (!/^[A-Za-z0-9_.*?%-]+$/.test(pattern)) return null
  return pattern
}

export function getMaintenanceSummary(
  db: DB,
  pattern = DEFAULT_IGNORE_PATTERN,
): MaintenanceSummary {
  const unpriced_count = (db.prepare(`
    SELECT COUNT(*) AS c FROM usage_records WHERE pricing_status = 'unpriced'
  `).get() as { c: number }).c
  const ignored_count = (db.prepare(`
    SELECT COUNT(*) AS c FROM usage_records WHERE pricing_status = 'ignored'
  `).get() as { c: number }).c
  const placeholder_unpriced_count = (db.prepare(`
    SELECT COUNT(*) AS c FROM usage_records
    WHERE pricing_status = 'unpriced' AND model GLOB ?
  `).get(pattern) as { c: number }).c
  const by_model = db.prepare(`
    SELECT model, provider, COUNT(*) AS count
    FROM usage_records
    WHERE pricing_status = 'unpriced'
    GROUP BY model, provider
    ORDER BY count DESC, model ASC
    LIMIT 15
  `).all() as MaintenanceModelCount[]
  return {
    unpriced_count,
    ignored_count,
    placeholder_unpriced_count,
    by_model,
    reprice: repriceUnpricedRecords(db, false),
    default_pattern: pattern,
  }
}

export function ignoreUnpricedByPattern(db: DB, pattern: string): MaintenanceActionResult {
  const result = db.prepare(`
    UPDATE usage_records
    SET pricing_status = 'ignored',
        pricing_source = 'maintenance:ignore',
        pricing_rule_id = NULL
    WHERE pricing_status = 'unpriced' AND model GLOB ?
  `).run(pattern)
  return { affected: Number(result.changes) || 0, pattern }
}

export function restoreIgnoredByPattern(db: DB, pattern: string | null): MaintenanceActionResult {
  if (pattern) {
    const result = db.prepare(`
      UPDATE usage_records
      SET pricing_status = 'unpriced',
          pricing_source = NULL,
          pricing_rule_id = NULL
      WHERE pricing_status = 'ignored' AND model GLOB ?
    `).run(pattern)
    return { affected: Number(result.changes) || 0, pattern }
  }
  const result = db.prepare(`
    UPDATE usage_records
    SET pricing_status = 'unpriced',
        pricing_source = NULL,
        pricing_rule_id = NULL
    WHERE pricing_status = 'ignored'
  `).run()
  return { affected: Number(result.changes) || 0, pattern: '*' }
}
