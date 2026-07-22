import Database from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BuildInfo } from '@tokember/contracts/release'
import { loadBuildInfo } from './build-info.js'
import { getReadiness } from './health.js'
import { LATEST_SCHEMA_VERSION } from './migrations.js'
import { registerUsageMetricFunctions } from './usage-metrics.js'

type RestoreSmokeCode = 'database' | 'schema' | 'readiness' | 'query'

export class RestoreSmokeError extends Error {
  constructor(readonly code: RestoreSmokeCode) {
    super(`restore_smoke_failed:${code}`)
    this.name = 'RestoreSmokeError'
  }
}

interface RestoreSmokeInput {
  path: string
  expectedSchema: number
  buildInfo: BuildInfo
}

const SMOKE_ENV = {
  NODE_ENV: 'production',
  TOKEMBER_API_KEY: 'restore-smoke-only',
  TOKEMBER_ADMIN_PASSWORD: 'restore-smoke-only',
  TOKEMBER_ALLOW_LEGACY_API_KEY: 'true',
}

function keyReads(db: Database.Database): void {
  try {
    db.prepare('SELECT COUNT(*) AS count FROM devices').get()
    db.prepare('SELECT COUNT(*) AS count FROM usage_records').get()
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
  } catch {
    throw new RestoreSmokeError('query')
  }
}

export function runRestoreSmoke(input: RestoreSmokeInput): void {
  if (input.expectedSchema !== LATEST_SCHEMA_VERSION) {
    throw new RestoreSmokeError('schema')
  }
  let db: Database.Database
  try {
    db = new Database(input.path, { readonly: true, fileMustExist: true, timeout: 5_000 })
  } catch {
    throw new RestoreSmokeError('database')
  }
  try {
    db.pragma('query_only = ON')
    registerUsageMetricFunctions(db)
    const readiness = getReadiness(db, input.buildInfo, { env: SMOKE_ENV })
    if (readiness.status !== 'ready') throw new RestoreSmokeError('readiness')
    keyReads(db)
  } catch (error) {
    if (error instanceof RestoreSmokeError) throw error
    throw new RestoreSmokeError('query')
  } finally {
    db.close()
  }
}

function requiredSchema(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RestoreSmokeError('schema')
  return parsed
}

function runCli(): void {
  const path = process.env.DB_PATH?.trim()
  if (!path) throw new RestoreSmokeError('database')
  runRestoreSmoke({
    path,
    expectedSchema: requiredSchema(process.env.TOKEMBER_EXPECTED_SCHEMA),
    buildInfo: loadBuildInfo(),
  })
  process.stdout.write('restore_smoke:ok\n')
}

export function isRestoreSmokeMain(argvPath = process.argv[1]): boolean {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isRestoreSmokeMain()) {
  try {
    runCli()
  } catch (error) {
    const code = error instanceof RestoreSmokeError ? error.code : 'query'
    process.stderr.write(`restore_smoke:failed:${code}\n`)
    process.exitCode = 1
  }
}
