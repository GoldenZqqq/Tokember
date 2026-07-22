// Home-state path resolution for Tokember-owned local files.
//
// Canonical default: ~/.tokember/<file>
// Legacy brand path: ~/.ai-burn/<file>
// If only the legacy file/dir exists, reuse it so a rename never resets cursors.
// When neither exists, new installs write under ~/.tokember.

import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type PathExists = (path: string) => boolean

export function resolveLegacyAwareHomePath(options: {
  fileName: string
  home?: string
  exists?: PathExists
}): string {
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const canonical = join(home, '.tokember', options.fileName)
  const legacy = join(home, '.ai-burn', options.fileName)
  if (exists(canonical)) return canonical
  if (exists(legacy)) return legacy
  return canonical
}

export function resolveLegacyAwareHomeDir(options: {
  home?: string
  exists?: PathExists
} = {}): string {
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const canonical = join(home, '.tokember')
  const legacy = join(home, '.ai-burn')
  if (exists(canonical)) return canonical
  if (exists(legacy)) return legacy
  return canonical
}

export function firstConfiguredEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = (env[key] || '').trim()
    if (value) return value
  }
  return ''
}
