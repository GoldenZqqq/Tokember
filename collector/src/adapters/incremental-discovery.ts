import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { IncrementalCursor } from '../incremental-cursor.js'
import { incrementalFileKey } from './incremental-jsonl.js'

interface DiscoveredPath {
  path: string
  mtime_ms: number
}

export interface IncrementalDiscoveryOptions {
  roots: string[]
  frontiers?: string[]
  cursor?: IncrementalCursor
  matches: (name: string) => boolean
}

export interface IncrementalDiscoveryResult {
  paths: string[]
  reconciling: boolean
  reconciliation_started_at: Date | null
}

async function pathStat(path: string) {
  return stat(path).catch(() => null)
}

function stageDirectories(
  cursor: IncrementalCursor | undefined,
  directories: DiscoveredPath[],
): void {
  if (!cursor) return
  const live = new Set(directories.map(directory => incrementalFileKey(directory.path)))
  for (const [key] of cursor.hotDirectoryEntries()) {
    if (!live.has(key)) cursor.removeDirectory(key)
  }
  directories.sort((a, b) => a.mtime_ms - b.mtime_ms)
  for (const directory of directories) {
    cursor.stageDirectory(incrementalFileKey(directory.path), directory)
  }
}

async function discoverComplete(
  roots: string[],
  matches: (name: string) => boolean,
  cursor?: IncrementalCursor,
): Promise<string[]> {
  const queue = [...roots]
  const directories: DiscoveredPath[] = []
  const files: DiscoveredPath[] = []
  while (queue.length > 0) {
    const directory = queue.shift()!
    const directoryStat = await pathStat(directory)
    if (!directoryStat?.isDirectory()) continue
    directories.push({ path: directory, mtime_ms: directoryStat.mtimeMs })
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && matches(entry.name)) {
        const fileStat = await pathStat(path)
        if (fileStat?.isFile()) files.push({ path, mtime_ms: fileStat.mtimeMs })
      }
    }
  }
  stageDirectories(cursor, directories)
  return files.sort((a, b) => a.mtime_ms - b.mtime_ms).map(file => file.path)
}

function fastDirectories(options: IncrementalDiscoveryOptions): string[] {
  const result = new Set(options.frontiers ?? options.roots)
  for (const [, directory] of options.cursor!.hotDirectoryEntries()) {
    result.add(directory.path)
  }
  return [...result]
}

async function discoverFast(options: IncrementalDiscoveryOptions): Promise<string[]> {
  // Fast path starts from roots + the bounded hot directory inventory. The hot
  // limit only bounds *persisted* inventory (stageDirectory). It must not stop
  // BFS under a directory whose mtime already changed — otherwise a full hot
  // set (Grok nests terminal/recap dirs under every session) permanently misses
  // brand-new sibling sessions until the 6h reconciliation.
  const files = new Set(options.cursor!.hotFileEntries().map(([, file]) => file.path))
  const queue = fastDirectories(options)
  const seen = new Set<string>()
  while (queue.length > 0) {
    const directory = queue.shift()!
    if (seen.has(directory)) continue
    seen.add(directory)
    const key = incrementalFileKey(directory)
    const directoryStat = await pathStat(directory)
    if (!directoryStat?.isDirectory()) {
      options.cursor!.removeDirectory(key)
      continue
    }
    if (!options.cursor!.directoryChanged(key, directoryStat.mtimeMs)) continue
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    options.cursor!.stageDirectory(key, { path: directory, mtime_ms: directoryStat.mtimeMs })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isFile() && options.matches(entry.name)) files.add(path)
      else if (entry.isDirectory() && !seen.has(path)) {
        queue.push(path)
      }
    }
  }
  return [...files]
}

export async function discoverIncrementalFiles(
  options: IncrementalDiscoveryOptions,
): Promise<IncrementalDiscoveryResult> {
  const reconciling = options.cursor?.needsReconciliation() ?? false
  const reconciliationStartedAt = reconciling ? new Date() : null
  let paths = !options.cursor || reconciling
    ? await discoverComplete(options.roots, options.matches, options.cursor)
    : await discoverFast(options)
  if (options.cursor && reconciling) {
    paths = [...new Set([
      ...paths,
      ...options.cursor.hotFileEntries().map(([, file]) => file.path),
    ])]
  }
  return {
    paths,
    reconciling,
    reconciliation_started_at: reconciliationStartedAt,
  }
}
