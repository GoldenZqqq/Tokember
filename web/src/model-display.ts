// Display-only model family helpers. Storage and pricing keep the raw model ID.

/**
 * Stable family key used to merge display variants of one model.
 * Strips billing/mode suffixes only; storage and pricing keep the raw ID.
 * Same-provider rows with the same key are summed by mergeByModelFamily.
 */
export function modelFamilyKey(model: string): string {
  const name = model.trim()
  if (!name) return name
  return name
    .replace(/-build-free$/i, '')
    .replace(/-build$/i, '')
    // Claude Code (and similar) emit base + thinking as separate model IDs.
    .replace(/-thinking$/i, '')
}

/** User-facing label for a raw model or family key. */
export function modelDisplayName(model: string): string {
  return modelFamilyKey(model).toLowerCase()
}

export interface ModelAggregateRow {
  model: string
  provider: string
  cost: number
  requests: number
  real_total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  unpriced_requests: number
}

export interface ModelFamilyRow extends ModelAggregateRow {
  /** Raw model IDs folded into this family row (for audit drill-down). */
  raw_models: string[]
}

/** Merge stats rows that share provider + model family. Sorted by cost desc. */
export function mergeByModelFamily(rows: ModelAggregateRow[]): ModelFamilyRow[] {
  const byKey = new Map<string, ModelFamilyRow>()
  for (const row of rows) {
    const family = modelFamilyKey(row.model)
    const key = `${row.provider}\u0000${family}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, {
        model: family,
        provider: row.provider,
        cost: row.cost,
        requests: row.requests,
        real_total_tokens: row.real_total_tokens,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_creation_tokens: row.cache_creation_tokens,
        unpriced_requests: row.unpriced_requests,
        raw_models: [row.model],
      })
      continue
    }
    existing.cost += row.cost
    existing.requests += row.requests
    existing.real_total_tokens += row.real_total_tokens
    existing.input_tokens += row.input_tokens
    existing.output_tokens += row.output_tokens
    existing.cache_read_tokens += row.cache_read_tokens
    existing.cache_creation_tokens += row.cache_creation_tokens
    existing.unpriced_requests += row.unpriced_requests
    if (!existing.raw_models.includes(row.model)) {
      existing.raw_models.push(row.model)
    }
  }
  return [...byKey.values()].sort((a, b) => b.cost - a.cost)
}
