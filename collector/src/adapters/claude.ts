// Claude Code native log adapter.
//
// Claude Code writes one JSONL file per session under
//   ~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl
// Each line is one event. Assistant events carry `message.usage` (token counts)
// and `message.model`. We read those directly — no cc-switch proxy needed.
//
// Parsing logic adapted from codeburn (MIT, github.com/getagentseal/codeburn),
// simplified to just the token extraction we need.

import { basename, join } from 'path'
import { homedir } from 'os'
import { IncrementalCursor } from '../incremental-cursor.js'
import { discoverIncrementalFiles } from './incremental-discovery.js'
import { commitIncrementalJsonl, prepareIncrementalJsonl } from './incremental-jsonl.js'
import {
  isInCollectionWindow,
  type CollectionObserver,
  type CollectionWindow,
  type UsageRecord,
} from './types.js'

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ClaudeEntry {
  type?: string
  timestamp?: string
  cwd?: string
  sessionId?: string
  session_id?: string
  message?: {
    id?: string
    model?: string
    usage?: ClaudeUsage
  }
}

function getClaudeProjectsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects')
}

// One assistant message can appear on multiple lines while streaming; each
// carries the same message.id and the last one holds the final token counts.
// We key on message.id and keep the last occurrence.
function parseSessionLines(
  options: {
    filePath: string
    lines: string[]
    byId: Map<string, UsageRecord>
    fallbackTimestamp: string
    window?: CollectionWindow
  },
): void {
  for (const line of options.lines) {
    let entry: ClaudeEntry
    try {
      entry = JSON.parse(line) as ClaudeEntry
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    const msg = entry.message
    if (!msg?.usage || !msg.model) continue
    const usage = msg.usage
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheCreation = usage.cache_creation_input_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    if (input === 0 && output === 0 && cacheCreation === 0 && cacheRead === 0) continue
    const timestamp = entry.timestamp ?? options.fallbackTimestamp
    if (!isInCollectionWindow(timestamp, options.window)) continue
    const id = msg.id ?? `${options.filePath}:${timestamp}`
    const session = entry.sessionId ?? entry.session_id ?? basename(options.filePath, '.jsonl')
    options.byId.set(id, {
      provider: 'claude', model: msg.model,
      input_tokens: input, output_tokens: output,
      cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation,
      reasoning_tokens: 0, cost_usd: 0, timestamp,
      source_file: 'claude-code', dedup_key: `claude:${id}`,
      attribution: {
        status: 'captured',
        ...(entry.cwd ? { project: { kind: 'path' as const, value: entry.cwd } } : {}),
        session,
      },
    })
  }
}

export async function collectClaude(
  window?: CollectionWindow,
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
): Promise<UsageRecord[]> {
  const projectsDir = getClaudeProjectsDir()
  const discovery = await discoverIncrementalFiles({
    roots: [projectsDir], cursor: incremental,
    matches: name => name.endsWith('.jsonl'),
  })
  observer?.discover(discovery.paths.length)

  // message.id is unique per assistant turn across the whole install, so a
  // single map dedups streaming duplicates within and across session files.
  const byId = new Map<string, UsageRecord>()
  for (const file of discovery.paths) {
    const result = await prepareIncrementalJsonl(file, incremental, {
      reconciling: discovery.reconciling,
    })
    if (result.kind !== 'read' || !result.signature) continue
    const timestamp = new Date(result.signature.mtime_ms).toISOString()
    observer?.scan(timestamp)
    parseSessionLines({
      filePath: file,
      lines: result.tail.lines,
      byId,
      fallbackTimestamp: timestamp,
      window,
    })
    commitIncrementalJsonl(incremental, result)
  }
  if (discovery.reconciliation_started_at) {
    incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }

  return [...byId.values()]
}
