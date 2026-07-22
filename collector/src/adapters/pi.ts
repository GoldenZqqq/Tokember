// Pi Agent / Oh My Pi session adapters.
//
// Pi coding agent writes JSONL sessions under:
//   ~/.pi/agent/sessions/--<cwd-sanitized>--/<timestamp>_<uuid>.jsonl
// Oh My Pi uses the same shape under ~/.omp/agent/sessions/.
//
// Billable turns are type=message + message.role=assistant + message.usage.
// Format: packages/coding-agent/docs/session-format.md (pi-mono).

import { basename, join } from 'path'
import { homedir } from 'os'

import { IncrementalCursor } from '../incremental-cursor.js'
import { discoverIncrementalFiles } from './incremental-discovery.js'
import { commitIncrementalJsonl, prepareIncrementalJsonl } from './incremental-jsonl.js'
import {
  isInCollectionWindow,
  type Adapter,
  type CollectionObserver,
  type CollectionWindow,
  type UsageRecord,
} from './types.js'

interface PiUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: {
    total?: number
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

interface PiMessage {
  role?: string
  model?: string
  responseId?: string
  usage?: PiUsage
}

interface PiEntry {
  type?: string
  id?: string
  timestamp?: string | number
  message?: PiMessage
}

export type PiProviderId = 'pi' | 'omp'

function sessionsRoot(provider: PiProviderId): string {
  if (provider === 'omp') {
    return process.env.OMP_SESSIONS_DIR
      ?? join(homedir(), '.omp', 'agent', 'sessions')
  }
  return process.env.PI_AGENT_SESSIONS_DIR
    ?? process.env.PI_SESSIONS_DIR
    ?? join(homedir(), '.pi', 'agent', 'sessions')
}

function toIsoTimestamp(value: string | number | undefined, fallback: string): string {
  if (value == null) return fallback
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
  }
  const raw = String(value).trim()
  if (!raw) return fallback
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(raw)) {
    return toIsoTimestamp(asNumber, fallback)
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function parseSessionLines(options: {
  provider: PiProviderId
  filePath: string
  lines: string[]
  byId: Map<string, UsageRecord>
  fallbackTimestamp: string
  sessionId: string
  window?: CollectionWindow
}): string {
  let sessionId = options.sessionId
  for (const [lineIndex, line] of options.lines.entries()) {
    let entry: PiEntry
    try {
      entry = JSON.parse(line) as PiEntry
    } catch {
      continue
    }
    if (entry.type === 'session' && entry.id) {
      sessionId = entry.id
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const msg = entry.message
    if (msg.role !== 'assistant' || !msg.usage) continue

    const input = msg.usage.input ?? 0
    const output = msg.usage.output ?? 0
    const cacheRead = msg.usage.cacheRead ?? 0
    const cacheWrite = msg.usage.cacheWrite ?? 0
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue

    const timestamp = toIsoTimestamp(entry.timestamp, options.fallbackTimestamp)
    if (!isInCollectionWindow(timestamp, options.window)) continue

    const model = msg.model?.trim() || 'pi-auto'
    const eventId = msg.responseId || entry.id || `${lineIndex}`
    const dedupKey = `${options.provider}:${sessionId}:${eventId}`
    const vendorCost = msg.usage.cost?.total
    const costUsd = typeof vendorCost === 'number' && Number.isFinite(vendorCost) && vendorCost > 0
      ? vendorCost
      : 0

    options.byId.set(dedupKey, {
      provider: options.provider,
      model,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      reasoning_tokens: 0,
      cost_usd: costUsd,
      ...(costUsd > 0 ? { cost_provided: true as const } : {}),
      timestamp,
      source_file: options.provider,
      dedup_key: dedupKey,
      attribution: { status: 'captured', session: sessionId },
    })
  }
  return sessionId
}

async function collectPiLike(
  provider: PiProviderId,
  window?: CollectionWindow,
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
): Promise<UsageRecord[]> {
  const root = sessionsRoot(provider)
  const discovery = await discoverIncrementalFiles({
    roots: [root],
    cursor: incremental,
    matches: name => name.endsWith('.jsonl'),
  })
  observer?.discover(discovery.paths.length)

  const byId = new Map<string, UsageRecord>()
  for (const file of discovery.paths) {
    const result = await prepareIncrementalJsonl(file, incremental, {
      reconciling: discovery.reconciling,
    })
    if (result.kind !== 'read' || !result.signature) continue
    const fallbackTimestamp = new Date(result.signature.mtime_ms).toISOString()
    observer?.scan(fallbackTimestamp)
    const priorSession = typeof result.previous_metadata.session_id === 'string'
      ? result.previous_metadata.session_id
      : basename(file, '.jsonl')
    const sessionId = parseSessionLines({
      provider,
      filePath: file,
      lines: result.tail.lines,
      byId,
      fallbackTimestamp,
      sessionId: priorSession,
      window,
    })
    commitIncrementalJsonl(incremental, result, {
      ...result.previous_metadata,
      session_id: sessionId,
    })
  }
  if (discovery.reconciliation_started_at) {
    incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }
  return [...byId.values()]
}

export const collectPi: Adapter = (window, observer, incremental) => (
  collectPiLike('pi', window, observer, incremental)
)

export const collectOmp: Adapter = (window, observer, incremental) => (
  collectPiLike('omp', window, observer, incremental)
)

export function getPiSessionsDir(): string {
  return sessionsRoot('pi')
}

export function getOmpSessionsDir(): string {
  return sessionsRoot('omp')
}
