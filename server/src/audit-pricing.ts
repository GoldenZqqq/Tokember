import type {
  AuditPricingExplanation,
  AuditPricingRule,
  AuditPublicRecord,
} from '@tokember/contracts/audit'
import {
  calculateRuleCost,
  type PricingRuleWithAliases,
} from './pricing.js'

function auditRule(rule: PricingRuleWithAliases): AuditPricingRule {
  return {
    id: rule.id, source: rule.source, model: rule.model, mode: rule.mode,
    input_price: rule.input_price, output_price: rule.output_price,
    cache_read_price: rule.cache_read_price, cache_write_price: rule.cache_write_price,
    enabled: rule.enabled === 1,
    aliases: rule.aliases.map(alias => ({ source: alias.source, alias: alias.alias })),
  }
}

export function pricingExplanation(
  record: AuditPublicRecord,
  ruleId: number | null,
  rules: Map<number, PricingRuleWithAliases>,
): AuditPricingExplanation {
  const rule = ruleId == null ? undefined : rules.get(ruleId)
  if (['provided', 'free', 'included', 'none'].includes(record.pricing_status)) {
    return {
      status: 'exact', recomputed_cost_usd: rule ? calculateRuleCost(rule, record) : record.cost_usd,
      current_rule: rule ? auditRule(rule) : null,
      evidence: record.pricing_status === 'provided'
        ? 'Collector-provided cost is authoritative.'
        : 'Stored pricing status is sufficient for this zero-cost result.',
    }
  }
  if (record.pricing_status === 'unpriced' || record.pricing_status === 'ignored') {
    return { status: 'not_applicable', recomputed_cost_usd: null, current_rule: null,
      evidence: 'No pricing rule was applied to this record.' }
  }
  if (!rule) {
    return { status: 'legacy_unknown', recomputed_cost_usd: null, current_rule: null,
      evidence: 'The referenced historical pricing rule is unavailable.' }
  }
  const recomputed = calculateRuleCost(rule, record)
  const tolerance = Math.max(1e-9, Math.abs(record.cost_usd) * 1e-9)
  const exact = Math.abs(recomputed - record.cost_usd) <= tolerance
  return {
    status: exact ? 'exact' : 'rule_drift', recomputed_cost_usd: recomputed,
    current_rule: auditRule(rule),
    evidence: exact
      ? 'The current referenced rule reproduces the stored cost.'
      : 'The current referenced rule no longer reproduces the stored cost.',
  }
}
