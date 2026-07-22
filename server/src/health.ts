import type { ProtocolWindow } from '@tokember/contracts/protocol'
import type { BuildInfo } from '@tokember/contracts/release'
import type { DB } from './db.js'
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from './migrations.js'
import { isReleaseBuild } from './build-info.js'
import { runtimeAuthConfigured } from './api-auth.js'
import { getProtocolWindow } from './protocol.js'

export const SERVER_STARTED_AT = new Date().toISOString()

export interface LivenessResponse {
  status: 'ok'
  release_id: string
  commit: string
  started_at: string
  protocol: ProtocolWindow
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready'
  release_id: string
  commit: string
  protocol: ProtocolWindow
  checks: {
    database: boolean
    schema: boolean
    config: boolean
    metadata: boolean
    runtime: boolean
  }
}

interface ReadinessOptions {
  env?: NodeJS.ProcessEnv
  runtimeVersion?: string
  runtimeArchitecture?: string
}

function databaseChecks(db: DB): { database: boolean; schema: boolean } {
  try {
    db.prepare('SELECT 1').get()
    return { database: true, schema: getSchemaVersion(db) === LATEST_SCHEMA_VERSION }
  } catch {
    return { database: false, schema: false }
  }
}

function runtimeMatches(buildInfo: BuildInfo, options: ReadinessOptions): boolean {
  const runtimeVersion = options.runtimeVersion ?? process.version.replace(/^v/, '')
  const runtimeArchitecture = options.runtimeArchitecture ?? process.arch
  return runtimeVersion.split('.')[0] === buildInfo.node_version.split('.')[0]
    && runtimeArchitecture === buildInfo.architecture
}

export function getLiveness(
  buildInfo: BuildInfo,
  startedAt = SERVER_STARTED_AT,
): LivenessResponse {
  return {
    status: 'ok',
    release_id: buildInfo.release_id,
    commit: buildInfo.commit,
    started_at: startedAt,
    protocol: getProtocolWindow(),
  }
}

export function getReadiness(
  db: DB,
  buildInfo: BuildInfo,
  options: ReadinessOptions = {},
): ReadinessResponse {
  const env = options.env ?? process.env
  const { database, schema } = databaseChecks(db)
  const production = env.NODE_ENV === 'production'
  const config = !production || runtimeAuthConfigured(db, env)
  const metadata = !production || isReleaseBuild(buildInfo)
  const runtime = !production || runtimeMatches(buildInfo, options)
  const checks = { database, schema, config, metadata, runtime }
  return {
    status: Object.values(checks).every(Boolean) ? 'ready' : 'not_ready',
    release_id: buildInfo.release_id,
    commit: buildInfo.commit,
    protocol: getProtocolWindow(),
    checks,
  }
}
