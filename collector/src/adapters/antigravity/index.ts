// Native Antigravity adapter for Tokember.
// Parsing and RPC discovery are adapted from getagentseal/codeburn (MIT).

import { readdir, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'

import { IncrementalCursor } from '../../incremental-cursor.js'
import { discoverIncrementalFiles } from '../incremental-discovery.js'
import {
  commitIncrementalFile,
  prepareIncrementalFile,
  retryIncrementalFile,
  type IncrementalFileResult,
} from '../incremental-file.js'
import { isInCollectionWindow, type Adapter, type UsageRecord } from '../types.js'
import { loadAntigravityCache, saveAntigravityCache } from './cache.js'
import { parseAntigravitySqlite } from './proto.js'
import { collectAntigravityRpcRecords } from './rpc.js'
import type { CachedCascade, ConversationRoot, ConversationSource } from './types.js'

const ANTIGRAVITY_WARNING_DETAIL_LIMIT = 5

export interface AntigravityWarningBudget {
  cacheFallback(id: string): void
  missingMetadata(id: string): void
  flush(): void
}

export function createAntigravityWarningBudget(
  warn: (message: string) => void = message => console.warn(message),
  detailLimit = ANTIGRAVITY_WARNING_DETAIL_LIMIT,
): AntigravityWarningBudget {
  const counts = { cache: 0, missing: 0 }
  const detail = (kind: keyof typeof counts, message: string): void => {
    counts[kind] += 1
    if (counts[kind] <= detailLimit) warn(message)
  }
  return {
    cacheFallback(id) {
      detail('cache', `  antigravity: RPC unavailable; using Tokember cache for ${id}`)
    },
    missingMetadata(id) {
      detail('missing', `  antigravity: no readable metadata for ${id}`)
    },
    flush() {
      const suppressedMissing = Math.max(0, counts.missing - detailLimit)
      const suppressedCache = Math.max(0, counts.cache - detailLimit)
      if (suppressedMissing > 0) {
        warn(`  antigravity: suppressed ${suppressedMissing} additional no-readable-metadata warning(s)`)
      }
      if (suppressedCache > 0) {
        warn(`  antigravity: suppressed ${suppressedCache} additional cache-fallback warning(s)`)
      }
    },
  }
}

function defaultRoots(): ConversationRoot[] {
  const base = process.env.ANTIGRAVITY_HOME ?? join(homedir(), '.gemini')
  return [
    { dir: join(base, 'antigravity', 'conversations'), app: 'antigravity', extensions: ['.pb', '.db'] },
    { dir: join(base, 'antigravity-cli', 'conversations'), app: 'antigravity-cli', extensions: ['.pb', '.db'] },
    { dir: join(base, 'antigravity-cli', 'implicit'), app: 'antigravity-cli', extensions: ['.pb'] },
    { dir: join(base, 'antigravity-ide', 'conversations'), app: 'antigravity-ide', extensions: ['.pb', '.db'] },
    { dir: join(base, 'antigravity-ide', 'implicit'), app: 'antigravity-ide', extensions: ['.pb'] },
  ]
}

function isConversationFile(file: string, extensions: readonly string[]): boolean {
  const normalized = file.toLowerCase()
  return extensions.some(extension => normalized.endsWith(extension))
}

export async function discoverAntigravitySources(
  roots: readonly ConversationRoot[] = defaultRoots(),
): Promise<ConversationSource[]> {
  const sources: ConversationSource[] = []
  for (const root of roots) {
    const files = await readdir(root.dir).catch(() => [] as string[])
    for (const file of files.sort()) {
      if (!isConversationFile(file, root.extensions)) continue
      const path = join(root.dir, file)
      if ((await stat(path).catch(() => null))?.isFile()) sources.push({ path, app: root.app })
    }
  }
  return sources
}

function cascadeId(path: string): string {
  return basename(path).replace(/\.(pb|db)$/i, '')
}

function sourceForPath(
  path: string,
  roots: readonly ConversationRoot[],
): ConversationSource | null {
  const parent = resolve(dirname(path))
  const root = roots.find(item => resolve(item.dir) === parent)
  return root && isConversationFile(path, root.extensions)
    ? { path, app: root.app }
    : null
}

async function discoverIncrementalSources(
  roots: readonly ConversationRoot[],
  incremental?: IncrementalCursor,
) {
  const discovery = await discoverIncrementalFiles({
    roots: roots.map(root => root.dir),
    cursor: incremental,
    matches: name => /\.(pb|db)$/i.test(name),
  })
  return {
    ...discovery,
    sources: discovery.paths
      .map(path => sourceForPath(path, roots))
      .filter((source): source is ConversationSource => source != null),
  }
}

async function parseSource(
  source: ConversationSource,
  fallbackTimestamp: string,
): Promise<UsageRecord[]> {
  const sqlite = await parseAntigravitySqlite(source.path, fallbackTimestamp)
  if (sqlite.length > 0) return sqlite
  return collectAntigravityRpcRecords(
    source.app,
    cascadeId(source.path),
    fallbackTimestamp,
  ).catch(() => [])
}

async function readSourceCandidate(options: {
  source: ConversationSource
  candidate: IncrementalFileResult
  cached?: CachedCascade
  id: string
  warnings: AntigravityWarningBudget
}): Promise<{ records: UsageRecord[]; retry: boolean; cacheEntry: CachedCascade | null }> {
  const { candidate, cached } = options
  if (!candidate.signature) return { records: [], retry: true, cacheEntry: null }
  if (cached
    && cached.mtimeMs === candidate.signature.mtime_ms
    && cached.sizeBytes === candidate.signature.size_bytes) {
    return { records: cached.records, retry: false, cacheEntry: null }
  }
  const fallback = new Date(candidate.signature.mtime_ms).toISOString()
  const parsed = await parseSource(options.source, fallback)
  if (parsed.length > 0) {
    return {
      records: parsed,
      retry: false,
      cacheEntry: {
        mtimeMs: candidate.signature.mtime_ms,
        sizeBytes: candidate.signature.size_bytes,
        records: parsed,
      },
    }
  }
  if (cached) {
    options.warnings.cacheFallback(options.id)
    return { records: cached.records, retry: true, cacheEntry: null }
  }
  options.warnings.missingMetadata(options.id)
  return { records: [], retry: true, cacheEntry: null }
}

export const collectAntigravity: Adapter = async (window, observer, incremental) => {
  const roots = defaultRoots()
  const discovery = await discoverIncrementalSources(roots, incremental)
  observer?.discover(discovery.sources.length)
  const cache = await loadAntigravityCache()
  const liveIds = new Set<string>()
  const records = new Map<string, UsageRecord>()
  const warnings = createAntigravityWarningBudget()
  let changed = false

  for (const source of discovery.sources) {
    const id = cascadeId(source.path)
    liveIds.add(id)
    const candidate = await prepareIncrementalFile(source.path, incremental, {
      reconciling: discovery.reconciling,
    })
    if (candidate.kind !== 'read' || !candidate.signature) continue
    const fallbackTimestamp = new Date(candidate.signature.mtime_ms).toISOString()
    observer?.scan(fallbackTimestamp)
    const cached = cache.cascades[id]
    const parsed = await readSourceCandidate({ source, candidate, cached, id, warnings })
    if (parsed.cacheEntry) {
      cache.cascades[id] = parsed.cacheEntry
      changed = true
    }
    for (const record of parsed.records) {
      if (isInCollectionWindow(record.timestamp, window)) records.set(record.dedup_key, record)
    }
    if (parsed.retry) retryIncrementalFile(incremental, candidate)
    else commitIncrementalFile(incremental, candidate)
  }

  if (!incremental || discovery.reconciling) {
    for (const id of Object.keys(cache.cascades)) {
      if (!liveIds.has(id)) {
        delete cache.cascades[id]
        changed = true
      }
    }
  }
  if (discovery.reconciliation_started_at) {
    incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }
  warnings.flush()
  if (changed) await saveAntigravityCache(cache)
  return [...records.values()]
}
