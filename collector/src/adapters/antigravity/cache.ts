import { readFile } from 'fs/promises'
import { join } from 'path'

import { atomicWriteText } from '../../atomic-file.js'
import { firstConfiguredEnv, resolveLegacyAwareHomeDir } from '../../runtime-paths.js'
import type { AntigravityCache } from './types.js'

const CACHE_VERSION = 1

export function getAntigravityCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const directory = firstConfiguredEnv(env, ['TOKEMBER_CACHE_DIR', 'AI_BURN_CACHE_DIR'])
    || resolveLegacyAwareHomeDir()
  return join(directory, 'antigravity-cache.json')
}

export async function loadAntigravityCache(
  path = getAntigravityCachePath(),
): Promise<AntigravityCache> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<AntigravityCache>
    if (parsed.version === CACHE_VERSION && parsed.cascades
      && typeof parsed.cascades === 'object' && !Array.isArray(parsed.cascades)) {
      return parsed as AntigravityCache
    }
  } catch { /* missing or obsolete cache */ }
  return { version: CACHE_VERSION, cascades: {} }
}

export async function saveAntigravityCache(
  cache: AntigravityCache,
  path = getAntigravityCachePath(),
): Promise<void> {
  await atomicWriteText(path, JSON.stringify(cache))
}
