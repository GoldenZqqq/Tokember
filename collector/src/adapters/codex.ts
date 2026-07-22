// Codex CLI adapter — reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
//
// Parsing logic adapted from codeburn (MIT, github.com/getagentseal/codeburn,
// src/providers/codex.ts), simplified to token accounting only.
//
// DELIBERATE DEVIATION from codeburn: codeburn normalizes to Anthropic
// semantics by reporting input_tokens WITHOUT the cached portion. Our server's
// pricing.ts:freshInput() and routes.ts real_total_tokens both assume a
// codex/gemini record's input_tokens still INCLUDES cache and subtract
// cache_read themselves. So here we report the RAW input_tokens (cache
// included); subtracting it too would double-subtract on the server.

import { join, basename } from 'path'
import { homedir } from 'os'
import { open } from 'fs/promises'
import type { CursorScalar } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import { discoverIncrementalFiles } from './incremental-discovery.js'
import { commitIncrementalJsonl, prepareIncrementalJsonl } from './incremental-jsonl.js'

import {
  isInCollectionWindow,
  type Adapter,
  type CollectionWindow,
  type UsageRecord,
} from './types.js'

interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

interface CodexEntry {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    model?: string
    session_id?: string
    forked_from_id?: string
    originator?: string
    cwd?: string
    info?: {
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

interface CodexContext {
  sessionId: string
  forkedFromId: string
  forkCutoff: string
  sessionModel: string
  prevCumulativeTotal: number | null
  projectPath: string
}

const CODEX_METADATA = [
  'session_id', 'forked_from_id', 'fork_cutoff',
  'session_model', 'prev_cumulative_total',
] as const

function getSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
}

function recentSessionDirectories(sessionsDir: string, now = new Date()): string[] {
  return Array.from({ length: 3 }, (_, offset) => {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return join(sessionsDir, year, month, day)
  })
}

function contextFrom(
  filePath: string,
  metadata: Record<string, CursorScalar>,
): CodexContext {
  return {
    sessionId: typeof metadata.session_id === 'string'
      ? metadata.session_id : basename(filePath, '.jsonl'),
    forkedFromId: typeof metadata.forked_from_id === 'string'
      ? metadata.forked_from_id : '',
    forkCutoff: typeof metadata.fork_cutoff === 'string' ? metadata.fork_cutoff : '',
    sessionModel: typeof metadata.session_model === 'string' ? metadata.session_model : 'gpt-5',
    prevCumulativeTotal: typeof metadata.prev_cumulative_total === 'number'
      ? metadata.prev_cumulative_total : null,
    projectPath: '',
  }
}

function contextMetadata(context: CodexContext): Record<string, CursorScalar> {
  return {
    session_id: context.sessionId,
    forked_from_id: context.forkedFromId,
    fork_cutoff: context.forkCutoff,
    session_model: context.sessionModel,
    prev_cumulative_total: context.prevCumulativeTotal,
  }
}

async function projectPathFromHeader(filePath: string): Promise<string> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/)) {
      if (!line) continue
      try {
        const entry = JSON.parse(line) as CodexEntry
        if (entry.type === 'session_meta' && entry.payload?.cwd) return entry.payload.cwd
      } catch {
        continue
      }
    }
  } catch {
    return ''
  } finally {
    await handle?.close()
  }
  return ''
}

function tokenRecord(options: {
  entry: CodexEntry
  context: CodexContext
  fallbackTimestamp: string
  window?: CollectionWindow
}): UsageRecord | null {
  const info = options.entry.payload?.info
  const last = info?.last_token_usage
  if (!last) return null
  const cumulativeTotal = info?.total_token_usage?.total_tokens ?? 0
  if (options.context.prevCumulativeTotal === cumulativeTotal) return null
  options.context.prevCumulativeTotal = cumulativeTotal
  const input = last.input_tokens ?? 0
  const output = last.output_tokens ?? 0
  const reasoning = last.reasoning_output_tokens ?? 0
  if (input + output + reasoning === 0) return null
  const timestamp = options.entry.timestamp ?? options.fallbackTimestamp
  if (!isInCollectionWindow(timestamp, options.window)) return null
  const total = info?.total_token_usage
  const namespace = options.context.forkedFromId || options.context.sessionId
  return {
    provider: 'codex', model: options.context.sessionModel,
    input_tokens: input, output_tokens: output,
    cache_read_tokens: last.cached_input_tokens ?? 0,
    cache_creation_tokens: 0, reasoning_tokens: reasoning,
    cost_usd: 0, timestamp, source_file: 'codex',
    dedup_key: `codex:${namespace}:${cumulativeTotal}:${total?.input_tokens ?? 0}:${total?.output_tokens ?? 0}:${total?.reasoning_output_tokens ?? 0}`,
    attribution: {
      status: 'captured',
      ...(options.context.projectPath
        ? { project: { kind: 'path' as const, value: options.context.projectPath } }
        : {}),
      session: options.context.sessionId,
    },
  }
}

function parseSessionLines(
  options: {
    lines: string[]
    out: UsageRecord[]
    context: CodexContext
    fallbackTimestamp: string
    window?: CollectionWindow
  },
): void {
  for (const line of options.lines) {
    let entry: CodexEntry
    try {
      entry = JSON.parse(line) as CodexEntry
    } catch {
      continue
    }
    if (entry.type === 'session_meta') {
      options.context.sessionId = entry.payload?.session_id ?? options.context.sessionId
      options.context.forkedFromId = entry.payload?.forked_from_id ?? ''
      const forkedAt = Date.parse(entry.timestamp ?? '')
      if (options.context.forkedFromId && Number.isFinite(forkedAt)) {
        options.context.forkCutoff = new Date(forkedAt + 5_000).toISOString()
      }
      options.context.sessionModel = entry.payload?.model ?? options.context.sessionModel
      options.context.projectPath = entry.payload?.cwd ?? options.context.projectPath
      continue
    }
    if (entry.type === 'turn_context' && entry.payload?.model) {
      options.context.sessionModel = entry.payload.model
      continue
    }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue
    if (options.context.forkCutoff
      && Date.parse(entry.timestamp ?? '') < Date.parse(options.context.forkCutoff)) {
      continue
    }
    const record = tokenRecord({
      entry,
      context: options.context,
      fallbackTimestamp: options.fallbackTimestamp,
      window: options.window,
    })
    if (record) options.out.push(record)
  }
}

export const collectCodex: Adapter = async (window, observer, incremental) => {
  const records: UsageRecord[] = []
  const sessionsDir = getSessionsDir()
  const discovery = await discoverIncrementalFiles({
    roots: [sessionsDir], frontiers: recentSessionDirectories(sessionsDir),
    cursor: incremental,
    matches: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  })
  observer?.discover(discovery.paths.length)
  for (const file of discovery.paths) {
    const result = await prepareIncrementalJsonl(file, incremental, {
      reconciling: discovery.reconciling,
      required_metadata: CODEX_METADATA,
    })
    if (result.kind !== 'read' || !result.signature) continue
    const fallback = new Date(result.signature.mtime_ms).toISOString()
    observer?.scan(fallback)
    const context = contextFrom(file, result.previous_metadata)
    context.projectPath = await projectPathFromHeader(file)
    parseSessionLines({
      lines: result.tail.lines,
      out: records,
      context,
      fallbackTimestamp: fallback,
      window,
    })
    commitIncrementalJsonl(incremental, result, contextMetadata(context))
  }
  if (discovery.reconciliation_started_at) {
    incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }

  return records
}
