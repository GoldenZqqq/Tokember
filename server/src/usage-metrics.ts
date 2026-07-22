import type { Database as DatabaseType } from 'better-sqlite3'
import type { CostCoverage } from '@tokember/contracts/stats'
import type { TokenInclusionSemantics } from '@tokember/contracts/usage'

export interface UsageMetricInput {
  provider: string
  request_count?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_tokens?: number | null
  cache_creation_tokens?: number | null
  reasoning_tokens?: number | null
  input_includes_cache_read?: boolean | number | null
  input_includes_cache_creation?: boolean | number | null
  output_includes_reasoning?: boolean | number | null
}

export interface NormalizedUsageMetrics extends TokenInclusionSemantics {
  request_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  reasoning_tokens: number
  fresh_input_tokens: number
  billable_output_tokens: number
  real_total_tokens: number
}

export const INCOMPLETE_PRICING_STATUSES = ['unpriced', 'ignored'] as const

function counter(value: number | null | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

function inclusion(value: boolean | number | null | undefined, fallback: boolean): boolean {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return fallback
}

export function defaultTokenSemantics(provider: string): TokenInclusionSemantics {
  return {
    input_includes_cache_read: provider === 'codex' || provider === 'gemini',
    input_includes_cache_creation: false,
    output_includes_reasoning: false,
  }
}

export function freshInputTokens(
  input: number,
  cacheRead: number,
  cacheCreation: number,
  includesRead: boolean,
  includesCreation: boolean,
): number {
  const includedCache = (includesRead ? cacheRead : 0)
    + (includesCreation ? cacheCreation : 0)
  return Math.max(input - includedCache, 0)
}

export function billableOutputTokens(
  output: number,
  reasoning: number,
  includesReasoning: boolean,
): number {
  return output + (includesReasoning ? 0 : reasoning)
}

export function normalizeUsageMetrics(input: UsageMetricInput): NormalizedUsageMetrics {
  const defaults = defaultTokenSemantics(input.provider)
  const semantics = {
    input_includes_cache_read: inclusion(
      input.input_includes_cache_read, defaults.input_includes_cache_read,
    ),
    input_includes_cache_creation: inclusion(
      input.input_includes_cache_creation, defaults.input_includes_cache_creation,
    ),
    output_includes_reasoning: inclusion(
      input.output_includes_reasoning, defaults.output_includes_reasoning,
    ),
  }
  const metrics = {
    request_count: input.request_count == null ? 1 : counter(input.request_count),
    input_tokens: counter(input.input_tokens),
    output_tokens: counter(input.output_tokens),
    cache_read_tokens: counter(input.cache_read_tokens),
    cache_creation_tokens: counter(input.cache_creation_tokens),
    reasoning_tokens: counter(input.reasoning_tokens),
  }
  const freshInput = freshInputTokens(
    metrics.input_tokens, metrics.cache_read_tokens, metrics.cache_creation_tokens,
    semantics.input_includes_cache_read, semantics.input_includes_cache_creation,
  )
  const billableOutput = billableOutputTokens(
    metrics.output_tokens, metrics.reasoning_tokens, semantics.output_includes_reasoning,
  )
  return {
    ...metrics,
    ...semantics,
    fresh_input_tokens: freshInput,
    billable_output_tokens: billableOutput,
    real_total_tokens: freshInput + metrics.cache_read_tokens
      + metrics.cache_creation_tokens + billableOutput,
  }
}

function ratio(covered: number, total: number): number {
  return total > 0 ? covered / total : 1
}

export function buildCostCoverage(
  totalCalls: number,
  totalTokens: number,
  unpricedCalls: number,
  unpricedTokens: number,
): CostCoverage {
  const calls = counter(totalCalls)
  const tokens = counter(totalTokens)
  const missingCalls = Math.min(counter(unpricedCalls), calls)
  const missingTokens = Math.min(counter(unpricedTokens), tokens)
  const pricedCalls = calls - missingCalls
  const pricedTokens = tokens - missingTokens
  return {
    priced_calls: pricedCalls,
    unpriced_calls: missingCalls,
    priced_tokens: pricedTokens,
    unpriced_tokens: missingTokens,
    call_ratio: ratio(pricedCalls, calls),
    token_ratio: ratio(pricedTokens, tokens),
  }
}

function bool(value: number): boolean {
  return value === 1
}

export function registerUsageMetricFunctions(db: DatabaseType): void {
  db.function('tokember_fresh_input_tokens', { deterministic: true },
    (input: number, read: number, creation: number, includesRead: number, includesCreation: number) =>
      freshInputTokens(counter(input), counter(read), counter(creation), bool(includesRead), bool(includesCreation)))
  db.function('tokember_billable_output_tokens', { deterministic: true },
    (output: number, reasoning: number, includesReasoning: number) =>
      billableOutputTokens(counter(output), counter(reasoning), bool(includesReasoning)))
  db.function('tokember_real_total_tokens', { deterministic: true },
    (
      input: number,
      output: number,
      cacheRead: number,
      cacheCreation: number,
      reasoning: number,
      includesRead: number,
      includesCreation: number,
      includesReasoning: number,
    ) => normalizeUsageMetrics({
      provider: '',
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      reasoning_tokens: reasoning,
      input_includes_cache_read: includesRead,
      input_includes_cache_creation: includesCreation,
      output_includes_reasoning: includesReasoning,
    }).real_total_tokens)
}

export function realTotalTokensSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `tokember_real_total_tokens(
    ${prefix}input_tokens, ${prefix}output_tokens,
    ${prefix}cache_read_tokens, ${prefix}cache_creation_tokens,
    ${prefix}reasoning_tokens, ${prefix}input_includes_cache_read,
    ${prefix}input_includes_cache_creation, ${prefix}output_includes_reasoning
  )`
}

export function freshInputTokensSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `tokember_fresh_input_tokens(
    ${prefix}input_tokens, ${prefix}cache_read_tokens,
    ${prefix}cache_creation_tokens, ${prefix}input_includes_cache_read,
    ${prefix}input_includes_cache_creation
  )`
}

export function billableOutputTokensSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `tokember_billable_output_tokens(
    ${prefix}output_tokens, ${prefix}reasoning_tokens,
    ${prefix}output_includes_reasoning
  )`
}
