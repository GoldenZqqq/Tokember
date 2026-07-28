import type { DB } from './db.js'
import type { PricingMode } from './pricing.js'

// Built-in pricing catalog: ships with the code so a fresh checkout has real
// costs instead of an all-`unpriced` database.
//
// Scope is deliberately narrow. Only models whose prices are verifiable against
// the vendor's own published table belong here, because a wrong built-in price
// silently miscounts money. Today that means Anthropic only
// (https://platform.claude.com/docs/en/about-claude/pricing). Third-party
// models stay user-owned: their public rates are harder to confirm and real
// deployments often route through gateways with negotiated prices.
//
// Two more rules keep this table honest:
//
// 1. Global rules only (`source IS NULL`). A source override encodes something
//    about one deployment — a gateway, an enterprise discount — so it can never
//    be shipped from upstream.
// 2. No duplicate spellings. `model-normalize.ts` already folds `claude-opus-4.8`
//    into `claude-opus-4-8`; listing both here would create two rules for one
//    model and split its usage.
//
// Bump REVISION when prices change so operators can tell catalogs apart.

export const CATALOG_REVISION = 2

export interface CatalogEntry {
  model: string
  mode: PricingMode
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
}

/** Prices are USD per one million tokens; cache writes use the 5-minute rate. */
export const PRICING_CATALOG: readonly CatalogEntry[] = [
  // Fable 5 / Mythos 5 share one price point.
  entry('claude-fable-5', 10, 50, 1, 12.5),
  entry('claude-mythos-5', 10, 50, 1, 12.5),
  // Opus 5 and the 4.x line share one price point.
  entry('claude-opus-5', 5, 25, 0.5, 6.25),
  entry('claude-opus-4-8', 5, 25, 0.5, 6.25),
  entry('claude-opus-4-7', 5, 25, 0.5, 6.25),
  entry('claude-opus-4-6', 5, 25, 0.5, 6.25),
  entry('claude-opus-4-5', 5, 25, 0.5, 6.25),
  // Sonnet 5 carries the standard rate, not the 2/10/0.2/2.5 introductory rate
  // that expires 2026-08-31. A catalog ships with a release and then sits in
  // databases for months, so a price with an expiry date would silently
  // undercount every deployment that had not upgraded by September. Overcounting
  // until then is the safer direction, and anyone who wants the exact
  // introductory rate can edit the rule — that marks it user_modified and later
  // catalog updates leave it alone.
  entry('claude-sonnet-5', 3, 15, 0.3, 3.75),
  entry('claude-sonnet-4-6', 3, 15, 0.3, 3.75),
  entry('claude-sonnet-4-5', 3, 15, 0.3, 3.75),
  entry('claude-haiku-4-5', 1, 5, 0.1, 1.25),
]

function entry(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): CatalogEntry {
  return {
    model,
    mode: 'priced',
    input_price: input,
    output_price: output,
    cache_read_price: cacheRead,
    cache_write_price: cacheWrite,
  }
}

export interface CatalogSyncResult {
  inserted: number
  updated: number
  preserved: number
}

interface ExistingRule {
  id: number
  model: string
  mode: PricingMode
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  origin: string
  user_modified: number
}

function samePrices(rule: ExistingRule, catalog: CatalogEntry): boolean {
  return rule.mode === catalog.mode
    && rule.input_price === catalog.input_price
    && rule.output_price === catalog.output_price
    && rule.cache_read_price === catalog.cache_read_price
    && rule.cache_write_price === catalog.cache_write_price
}

/**
 * Merge the catalog into `pricing_rules`, never overwriting operator intent.
 *
 * Only global rules participate: a source override is deployment-specific, and
 * leaving it untouched lets a gateway price win over the public rate.
 */
export function syncPricingCatalog(db: DB): CatalogSyncResult {
  const existing = db.prepare(`
    SELECT id, model, mode, input_price, output_price, cache_read_price,
           cache_write_price, origin, user_modified
    FROM pricing_rules WHERE source IS NULL
  `).all() as ExistingRule[]
  const byModel = new Map(existing.map(rule => [rule.model, rule]))

  const insert = db.prepare(`
    INSERT INTO pricing_rules
      (source, model, mode, input_price, output_price,
       cache_read_price, cache_write_price, enabled, origin, user_modified)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, 'builtin', 0)
  `)
  const update = db.prepare(`
    UPDATE pricing_rules SET mode = ?, input_price = ?, output_price = ?,
      cache_read_price = ?, cache_write_price = ?, updated_at = datetime('now')
    WHERE id = ?
  `)

  const result: CatalogSyncResult = { inserted: 0, updated: 0, preserved: 0 }
  db.transaction(() => {
    for (const catalog of PRICING_CATALOG) {
      const rule = byModel.get(catalog.model)
      if (!rule) {
        insert.run(catalog.model, catalog.mode, catalog.input_price,
          catalog.output_price, catalog.cache_read_price, catalog.cache_write_price)
        result.inserted++
        continue
      }
      // Operator-owned rows are untouchable: either the operator edited this
      // rule, or it predates the catalog and its price may be a gateway rate.
      if (rule.origin !== 'builtin' || rule.user_modified === 1) {
        result.preserved++
        continue
      }
      if (samePrices(rule, catalog)) continue
      update.run(catalog.mode, catalog.input_price, catalog.output_price,
        catalog.cache_read_price, catalog.cache_write_price, rule.id)
      result.updated++
    }
  })()
  return result
}
