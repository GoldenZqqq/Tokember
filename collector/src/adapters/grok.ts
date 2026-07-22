// Grok Build native adapter — reads ~/.grok/sessions/**/updates.jsonl.
//
// Authoritative spend is written when a turn ends:
//   method: "_x.ai/session/update"
//   update.sessionUpdate: "turn_completed"
//   update.usage: { inputTokens, outputTokens, cachedReadTokens, reasoningTokens, modelUsage? }
//
// Token semantics (xAI headless + ACP samples):
//   inputTokens = uncached input only
//   cachedReadTokens / cacheReadInputTokens = cache hits
//   Do NOT subtract cache from input again (unlike codex/gemini raw-input).
//
// signals.json context counters are NOT billing-grade — never use them.
// Incomplete turns (no turn_completed yet) are skipped until the next run.

import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import type { CursorScalar } from '../collector-state.js'
import { discoverIncrementalFiles } from './incremental-discovery.js'
import { commitIncrementalJsonl, prepareIncrementalJsonl } from './incremental-jsonl.js'

import {
  isInCollectionWindow,
  type Adapter,
  type CollectionWindow,
  type UsageRecord,
} from './types.js'

interface GrokModelUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cacheReadInputTokens?: number
  reasoningTokens?: number
  modelCalls?: number
  costUSD?: number
  // headless-style aliases
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  reasoning_tokens?: number
}

interface GrokUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cacheReadInputTokens?: number
  reasoningTokens?: number
  modelCalls?: number
  numTurns?: number
  modelUsage?: Record<string, GrokModelUsage>
  total_cost_usd?: number
  total_cost_usd_ticks?: number
  cost_is_partial?: boolean
  usage_is_incomplete?: boolean
  // headless-style aliases
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  reasoning_tokens?: number
}

interface GrokUpdate {
  sessionUpdate?: string
  prompt_id?: string
  stop_reason?: string
  usage?: GrokUsage
  usage_is_incomplete?: boolean
  _meta?: {
    modelId?: string
    agentTimestampMs?: number
    promptId?: string
  }
}

interface GrokEntry {
  timestamp?: number | string
  method?: string
  params?: {
    sessionId?: string
    update?: GrokUpdate
    _meta?: {
      agentTimestampMs?: number
      eventId?: string
    }
  }
}

interface GrokContext {
  sessionId: string
  lastModelId: string
}

const GROK_METADATA = ['session_id', 'last_model_id'] as const

function getGrokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok')
}

function getSessionsDir(): string {
  return process.env.GROK_SESSIONS_DIR ?? join(getGrokHome(), 'sessions')
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function readTokens(row: GrokModelUsage | GrokUsage): {
  input: number
  output: number
  cacheRead: number
  reasoning: number
} {
  return {
    // Uncached input — prefer camelCase ACP fields, fall back to snake_case.
    input: num(row.inputTokens ?? row.input_tokens),
    output: num(row.outputTokens ?? row.output_tokens),
    cacheRead: num(
      row.cachedReadTokens
      ?? row.cacheReadInputTokens
      ?? row.cache_read_input_tokens,
    ),
    reasoning: num(row.reasoningTokens ?? row.reasoning_tokens),
  }
}

function toIsoTimestamp(
  entry: GrokEntry,
  update: GrokUpdate,
  fallback: string,
): string {
  const agentMs = update._meta?.agentTimestampMs
    ?? entry.params?._meta?.agentTimestampMs
  if (typeof agentMs === 'number' && Number.isFinite(agentMs) && agentMs > 0) {
    return new Date(agentMs).toISOString()
  }

  const ts = entry.timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // ACP samples use unix seconds; treat large values as millis.
    const ms = ts > 1e12 ? ts : ts * 1000
    return new Date(ms).toISOString()
  }
  if (typeof ts === 'string' && ts.trim()) {
    const parsed = Date.parse(ts)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return fallback
}

function isTurnCompleted(entry: GrokEntry): entry is GrokEntry & {
  params: { update: GrokUpdate }
} {
  const method = entry.method
  const update = entry.params?.update
  if (!update || update.sessionUpdate !== 'turn_completed') return false
  // Prefer the xAI extension method; still accept turn_completed on any method
  // in case the envelope changes while the update shape stays stable.
  if (method && method !== '_x.ai/session/update' && method !== 'session/update') {
    return false
  }
  return true
}

function buildRecord(args: {
  sessionId: string
  promptId: string
  model: string
  tokens: ReturnType<typeof readTokens>
  costUsd: number
  costProvided: boolean
  timestamp: string
}): UsageRecord | null {
  const { input, output, cacheRead, reasoning } = args.tokens
  if (input === 0 && output === 0 && cacheRead === 0 && reasoning === 0) {
    return null
  }
  return {
    provider: 'grok',
    model: args.model,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
    reasoning_tokens: reasoning,
    cost_usd: args.costProvided ? args.costUsd : 0,
    timestamp: args.timestamp,
    source_file: 'grok-build',
    dedup_key: `grok:${args.sessionId}:${args.promptId}:${args.model}`,
    attribution: { status: 'captured', session: args.sessionId },
    ...(args.costProvided ? { cost_provided: true as const } : {}),
  }
}

function recordsFromModelUsage(options: {
  modelUsage: Record<string, GrokModelUsage>
  sessionId: string
  promptId: string
  fallbackModel: string
  timestamp: string
  costPartial: boolean
}): UsageRecord[] {
  const records: UsageRecord[] = []
  for (const [model, row] of Object.entries(options.modelUsage)) {
    const modelCost = num(row.costUSD)
    const record = buildRecord({
      sessionId: options.sessionId,
      promptId: options.promptId,
      model: model || options.fallbackModel || 'unknown',
      tokens: readTokens(row),
      costUsd: modelCost,
      costProvided: !options.costPartial && modelCost > 0,
      timestamp: options.timestamp,
    })
    if (record) records.push(record)
  }
  return records
}

function recordsFromTurn(options: {
  entry: GrokEntry
  update: GrokUpdate
  sessionId: string
  fallbackModel: string
  fallbackTimestamp: string
  window?: CollectionWindow
}): UsageRecord[] {
  if (options.update.usage_is_incomplete === true) return []
  const usage = options.update.usage
  if (!usage || usage.usage_is_incomplete === true) return []

  const promptId = options.update.prompt_id
    ?? options.update._meta?.promptId
    ?? ''
  if (!promptId) return []

  const timestamp = toIsoTimestamp(options.entry, options.update, options.fallbackTimestamp)
  if (!isInCollectionWindow(timestamp, options.window)) return []

  const modelUsage = usage.modelUsage
  const costPartial = usage.cost_is_partial === true
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    return recordsFromModelUsage({
      modelUsage,
      sessionId: options.sessionId,
      promptId,
      fallbackModel: options.fallbackModel,
      timestamp,
      costPartial,
    })
  }

  // Top-level usage only — single model fallback.
  const tokens = readTokens(usage)
  const totalCost = num(usage.total_cost_usd)
  const costProvided = !costPartial && totalCost > 0
  const model = options.fallbackModel || 'unknown'
  const record = buildRecord({
    sessionId: options.sessionId,
    promptId,
    model,
    tokens,
    costUsd: totalCost,
    costProvided,
    timestamp,
  })
  return record ? [record] : []
}

function grokContext(
  filePath: string,
  metadata: Record<string, CursorScalar>,
): GrokContext {
  return {
    sessionId: typeof metadata.session_id === 'string'
      ? metadata.session_id : basename(dirname(filePath)),
    lastModelId: typeof metadata.last_model_id === 'string'
      ? metadata.last_model_id : '',
  }
}

function grokMetadata(context: GrokContext): Record<string, CursorScalar> {
  return { session_id: context.sessionId, last_model_id: context.lastModelId }
}

function parseUpdatesLines(
  options: {
    lines: string[]
    out: Map<string, UsageRecord>
    context: GrokContext
    fallbackTimestamp: string
    window?: CollectionWindow
  },
): void {
  for (const line of options.lines) {
    let entry: GrokEntry
    try {
      entry = JSON.parse(line) as GrokEntry
    } catch {
      continue
    }
    if (entry.params?.sessionId) options.context.sessionId = entry.params.sessionId
    const update = entry.params?.update
    const chunkModel = update?._meta?.modelId
    if (chunkModel) options.context.lastModelId = chunkModel
    if (!isTurnCompleted(entry) || !update) continue
    const records = recordsFromTurn({
      entry,
      update,
      sessionId: options.context.sessionId,
      fallbackModel: options.context.lastModelId,
      fallbackTimestamp: options.fallbackTimestamp,
      window: options.window,
    })
    for (const record of records) options.out.set(record.dedup_key, record)
  }
}

export const collectGrok: Adapter = async (window, observer, incremental) => {
  const sessionsDir = getSessionsDir()
  const discovery = await discoverIncrementalFiles({
    roots: [sessionsDir], cursor: incremental,
    matches: name => name === 'updates.jsonl',
  })
  observer?.discover(discovery.paths.length)
  const byKey = new Map<string, UsageRecord>()
  for (const file of discovery.paths) {
    const result = await prepareIncrementalJsonl(file, incremental, {
      reconciling: discovery.reconciling,
      required_metadata: GROK_METADATA,
    })
    if (result.kind !== 'read' || !result.signature) continue
    const fallback = new Date(result.signature.mtime_ms).toISOString()
    observer?.scan(fallback)
    const context = grokContext(file, result.previous_metadata)
    parseUpdatesLines({
      lines: result.tail.lines,
      out: byKey,
      context,
      fallbackTimestamp: fallback,
      window,
    })
    commitIncrementalJsonl(incremental, result, grokMetadata(context))
  }
  if (discovery.reconciliation_started_at) {
    incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }
  return [...byKey.values()]
}
