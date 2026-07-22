import { createHash, randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const BACKUP_ID = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/
const SAFE_CODES = new Set([
  'busy', 'timeout', 'io', 'checksum', 'schema', 'integrity', 'smoke', 'status',
])

export const DEFAULT_KEEP = 28

export class RecoveryError extends Error {
  constructor(code) {
    super(`recovery_failed:${SAFE_CODES.has(code) ? code : 'io'}`)
    this.name = 'RecoveryError'
    this.code = SAFE_CODES.has(code) ? code : 'io'
  }
}

function safeChild(root, candidate) {
  const path = relative(resolve(root), resolve(candidate))
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new RecoveryError('io')
  }
  return candidate
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function ensureLayout(root) {
  const staging = join(root, '.staging')
  const sets = join(root, 'sets')
  await ensureDirectory(root)
  await ensureDirectory(staging)
  await ensureDirectory(sets)
  return { staging, sets, status: join(root, 'status.json') }
}

async function syncPath(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  await rename(temporary, path)
  await syncPath(resolve(path, '..'))
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function schemaVersion(db) {
  try {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    const version = Number(row?.version)
    if (!Number.isSafeInteger(version) || version < 1) throw new RecoveryError('schema')
    return version
  } catch (error) {
    throw error instanceof RecoveryError ? error : new RecoveryError('schema')
  }
}

function verifyDatabase(Database, path, expectedSchema) {
  let db
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 })
    db.pragma('query_only = ON')
    if (schemaVersion(db) !== expectedSchema) throw new RecoveryError('schema')
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new RecoveryError('integrity')
    }
  } catch (error) {
    if (error instanceof RecoveryError) throw error
    throw new RecoveryError(db == null ? 'io' : 'integrity')
  } finally {
    db?.close()
  }
}

function mapBackupError(error) {
  if (error instanceof RecoveryError) return error
  if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
    return new RecoveryError('busy')
  }
  return new RecoveryError('io')
}

async function transferBackup({ source, destination, options, dependencies }) {
  const backup = dependencies.backup ?? ((db, path, config) => db.backup(path, config))
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolveSleep => {
    setTimeout(resolveSleep, milliseconds)
  }))
  const clock = dependencies.clock ?? (() => performance.now())
  const deadline = clock() + options.timeoutMs
  let attempt = 0
  while (attempt <= options.retries) {
    await rm(destination, { force: true })
    try {
      return await backup(source, destination, {
        progress: info => {
          options.onProgress?.(info)
          if (clock() > deadline) throw new RecoveryError('timeout')
          return options.pagesPerStep
        },
      })
    } catch (error) {
      const mapped = mapBackupError(error)
      if (mapped.code !== 'busy' || attempt >= options.retries) throw mapped
      attempt += 1
      await sleep(attempt * 250)
    }
  }
  throw new RecoveryError('busy')
}

function backupId(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

function backupOptions(input) {
  return {
    timeoutMs: input.timeoutMs ?? 600_000,
    retries: input.retries ?? 2,
    pagesPerStep: input.pagesPerStep ?? 256,
    onProgress: input.onProgress,
  }
}

export async function createVerifiedBackup(input, dependencies = {}) {
  const layout = await ensureLayout(input.backupRoot)
  const staging = await mkdtemp(join(layout.staging, 'backup-'))
  await chmod(staging, 0o700)
  const destination = join(staging, 'tokember.db')
  const started = performance.now()
  let source
  try {
    source = new input.Database(input.sourcePath, {
      readonly: true, fileMustExist: true, timeout: 5_000,
    })
    source.pragma('query_only = ON')
    const expectedSchema = schemaVersion(source)
    const result = await transferBackup({
      source, destination, options: backupOptions(input), dependencies,
    })
    await chmod(destination, 0o600)
    await syncPath(destination)
    verifyDatabase(input.Database, destination, expectedSchema)
    const info = await stat(destination)
    const manifest = {
      manifest_schema_version: 1,
      created_at: (input.now?.() ?? new Date()).toISOString(),
      database_schema_version: expectedSchema,
      backup_bytes: info.size,
      sha256: await sha256(destination),
      backup_duration_ms: Math.round(performance.now() - started),
      total_pages: Number(result?.totalPages) || 0,
      integrity: 'passed',
    }
    const manifestPath = join(staging, 'manifest.json')
    await atomicJson(manifestPath, manifest)
    const id = backupId(input.now?.() ?? new Date())
    if (!BACKUP_ID.test(id)) throw new RecoveryError('io')
    const directory = safeChild(layout.sets, join(layout.sets, id))
    await rename(staging, directory)
    await syncPath(layout.sets)
    return {
      directory,
      databasePath: join(directory, 'tokember.db'),
      manifestPath: join(directory, 'manifest.json'),
      manifest,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw mapBackupError(error)
  } finally {
    source?.close()
  }
}

function defaultDrill() {
  return {
    state: 'never', last_attempt_at: null, last_success_at: null, duration_ms: null,
  }
}

function defaultStatus() {
  return {
    status_schema_version: 1,
    last_attempt_at: null,
    last_success_at: null,
    last_failure_at: null,
    backup_bytes: null,
    backup_schema_version: null,
    integrity: 'never',
    error_code: null,
    drill: defaultDrill(),
  }
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function normalizeStatus(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return defaultStatus()
  const drill = value.drill != null && typeof value.drill === 'object' ? value.drill : {}
  const drillState = ['never', 'passed', 'failed'].includes(drill.state) ? drill.state : 'never'
  return {
    status_schema_version: 1,
    last_attempt_at: timestamp(value.last_attempt_at),
    last_success_at: timestamp(value.last_success_at),
    last_failure_at: timestamp(value.last_failure_at),
    backup_bytes: nonnegative(value.backup_bytes),
    backup_schema_version: nonnegative(value.backup_schema_version),
    integrity: ['never', 'passed', 'failed'].includes(value.integrity)
      ? value.integrity : 'never',
    error_code: SAFE_CODES.has(value.error_code) ? value.error_code : null,
    drill: {
      state: drillState,
      last_attempt_at: timestamp(drill.last_attempt_at),
      last_success_at: timestamp(drill.last_success_at),
      duration_ms: nonnegative(drill.duration_ms),
    },
  }
}

export async function readRecoveryStatus(backupRoot) {
  try {
    return normalizeStatus(JSON.parse(await readFile(join(backupRoot, 'status.json'), 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return defaultStatus()
    throw new RecoveryError('status')
  }
}

async function writeRecoveryStatus(backupRoot, status) {
  const layout = await ensureLayout(backupRoot)
  try {
    await atomicJson(layout.status, normalizeStatus(status))
  } catch {
    throw new RecoveryError('status')
  }
}

async function defaultRunSmoke(input) {
  if (!input.restoreSmokePath || !input.buildMetadataPath) throw new RecoveryError('smoke')
  await execFile(process.execPath, [input.restoreSmokePath], {
    env: {
      PATH: process.env.PATH,
      DB_PATH: input.databasePath,
      TOKEMBER_EXPECTED_SCHEMA: String(input.expectedSchema),
      TOKEMBER_BUILD_METADATA: input.buildMetadataPath,
    },
    timeout: input.smokeTimeoutMs ?? 60_000,
    windowsHide: true,
  })
}

export async function runRestoreDrill(backup, input, dependencies = {}) {
  const layout = await ensureLayout(input.backupRoot)
  const staging = await mkdtemp(join(layout.staging, 'restore-'))
  await chmod(staging, 0o700)
  const restored = join(staging, 'tokember.db')
  const started = performance.now()
  try {
    await copyFile(backup.databasePath, restored)
    await chmod(restored, 0o600)
    if (await sha256(restored) !== backup.manifest.sha256) {
      throw new RecoveryError('checksum')
    }
    verifyDatabase(
      input.Database, restored, backup.manifest.database_schema_version,
    )
    const runSmoke = dependencies.runSmoke ?? defaultRunSmoke
    try {
      await runSmoke({
        ...input,
        databasePath: restored,
        expectedSchema: backup.manifest.database_schema_version,
      })
    } catch (error) {
      if (error instanceof RecoveryError) throw error
      throw new RecoveryError('smoke')
    }
    return { durationMs: Math.round(performance.now() - started) }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function pruneBackups(backupRoot, keep) {
  const layout = await ensureLayout(backupRoot)
  const entries = (await readdir(layout.sets, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && BACKUP_ID.test(entry.name))
    .map(entry => entry.name)
    .sort()
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    await rm(safeChild(layout.sets, join(layout.sets, name)), {
      recursive: true, force: true,
    })
  }
}

function asRecoveryError(error, fallback) {
  return error instanceof RecoveryError ? error : new RecoveryError(fallback)
}

async function recordFailure({ root, current, attemptedAt, error, drill }) {
  const failed = {
    ...current,
    last_attempt_at: attemptedAt,
    last_failure_at: attemptedAt,
    error_code: error.code,
    ...(drill ? { drill: { ...current.drill, state: 'failed', last_attempt_at: attemptedAt } } : {}),
  }
  await writeRecoveryStatus(root, failed)
}

export async function runRecoveryCycle(input, dependencies = {}) {
  const current = await readRecoveryStatus(input.backupRoot)
  const attemptedAt = (input.now?.() ?? new Date()).toISOString()
  await writeRecoveryStatus(input.backupRoot, { ...current, last_attempt_at: attemptedAt })
  const createBackup = dependencies.createBackup ?? createVerifiedBackup
  let backup
  try {
    backup = await createBackup(input, dependencies)
  } catch (error) {
    const mapped = asRecoveryError(error, 'io')
    await recordFailure({
      root: input.backupRoot, current, attemptedAt, error: mapped, drill: false,
    })
    throw mapped
  }
  const backedUp = {
    ...current,
    last_attempt_at: attemptedAt,
    last_success_at: backup.manifest.created_at,
    backup_bytes: backup.manifest.backup_bytes,
    backup_schema_version: backup.manifest.database_schema_version,
    integrity: 'passed',
    error_code: null,
  }
  await writeRecoveryStatus(input.backupRoot, backedUp)
  const runDrill = dependencies.runDrill ?? runRestoreDrill
  try {
    const result = await runDrill(backup, input, dependencies)
    const completed = {
      ...backedUp,
      error_code: null,
      drill: {
        state: 'passed',
        last_attempt_at: attemptedAt,
        last_success_at: attemptedAt,
        duration_ms: result.durationMs,
      },
    }
    await writeRecoveryStatus(input.backupRoot, completed)
    await pruneBackups(input.backupRoot, input.keep ?? DEFAULT_KEEP)
    return { backup, status: completed }
  } catch (error) {
    const mapped = asRecoveryError(error, 'smoke')
    await recordFailure({
      root: input.backupRoot, current: backedUp, attemptedAt, error: mapped, drill: true,
    })
    throw mapped
  }
}
