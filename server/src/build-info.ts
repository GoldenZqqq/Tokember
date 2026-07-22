import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { BuildInfo } from '@tokember/contracts/release'

const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ARCHITECTURE_PATTERN = /^[a-z0-9_]+$/

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validString(value: unknown, pattern?: RegExp): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && (pattern == null || pattern.test(value))
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(
      readFileSync(join(here, '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function validDependencies(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.entries(value).every(([path, version]) => (
    path.startsWith('node_modules/') && typeof version === 'string' && version.length > 0
  ))
}

export function decodeBuildInfo(value: unknown): BuildInfo | null {
  if (!isObject(value) || value.schema_version !== 2) return null
  const stringFields: [unknown, RegExp?][] = [
    [value.release_id, RELEASE_PATTERN],
    [value.version],
    [value.commit, COMMIT_PATTERN],
    [value.node_version],
    [value.architecture, ARCHITECTURE_PATTERN],
    [value.lockfile_sha256, HASH_PATTERN],
  ]
  if (!stringFields.every(([field, pattern]) => validString(field, pattern))) return null
  if (!validTimestamp(value.built_at) || !validDependencies(value.runtime_dependencies)) return null
  return value as unknown as BuildInfo
}

export function developmentBuildInfo(now = new Date()): BuildInfo {
  return {
    schema_version: 2,
    release_id: 'development',
    version: packageVersion(),
    commit: 'unknown',
    built_at: now.toISOString(),
    node_version: process.version.replace(/^v/, ''),
    architecture: process.arch,
    lockfile_sha256: 'unknown',
    runtime_dependencies: {},
  }
}

export function loadBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const path = env.TOKEMBER_BUILD_METADATA?.trim()
  if (!path) return developmentBuildInfo()
  try {
    return decodeBuildInfo(JSON.parse(readFileSync(path, 'utf8'))) ?? developmentBuildInfo()
  } catch {
    return developmentBuildInfo()
  }
}

export function isReleaseBuild(info: BuildInfo): boolean {
  return COMMIT_PATTERN.test(info.commit)
    && HASH_PATTERN.test(info.lockfile_sha256)
    && info.release_id !== 'development'
}

export const BUILD_INFO = loadBuildInfo()
