import type { DB } from './db.js'

// Canonical built-in model name mapping.
//
// Lesson learned the hard way: mechanical transforms are WRONG here. Vendors
// disagree on spelling — `gpt-5.6-sol` and `glm-5.2` use dots as real version
// separators, so a blanket dot→dash rule corrupts them into `gpt-5-6-sol` /
// `glm-5-2`. Lowercasing mangles `GLM-5.2`. Only Anthropic writes dashes.
//
// So we do NOT transform anything. Like cc-switch, we keep the original model
// name as-is, and ONLY merge KNOWN duplicate spellings of the SAME model via an
// explicit table below. Everything not in the table passes through untouched.
//
// Add a row here only when you've confirmed two names are genuinely the same
// model. Left = a spelling seen in the wild; right = the canonical name.
const ALIASES: Record<string, string> = {
  // Claude: dotted form → dashed (Anthropic's own logs write dashes).
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-opus-4.5': 'claude-opus-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  // Claude: reversed word order.
  'claude-4.6-sonnet': 'claude-sonnet-4-6',
  // Claude: dated release id → undated short name (unifies with the rows above
  // so opus-4-5 doesn't split across `...-20251101` and the short form).
  'claude-opus-4-5-20251101': 'claude-opus-4-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  // GLM: vendor-prefixed form → the bare name used elsewhere.
  'z-ai/glm-5.2': 'GLM-5.2',
}

export function normalizeModel(raw: string): string {
  if (typeof raw !== 'string') return raw
  const name = raw.trim()
  return ALIASES[name] ?? name
}

function findManagedAlias(db: DB, source: string, alias: string): string | null {
  const row = db.prepare(`
    SELECT pricing_rules.model
    FROM model_aliases
    JOIN pricing_rules ON pricing_rules.id = model_aliases.pricing_rule_id
    WHERE model_aliases.source = ? AND model_aliases.alias = ?
    LIMIT 1
  `).get(source, alias) as { model: string } | undefined
  return row?.model ?? null
}

export function resolveModelName(db: DB, source: string, raw: string): string {
  if (typeof raw !== 'string') return raw
  const name = raw.trim()
  const exact = findManagedAlias(db, source, name)
  if (exact) return exact

  const builtIn = normalizeModel(name)
  if (builtIn === name) return name
  return findManagedAlias(db, source, builtIn) ?? builtIn
}
