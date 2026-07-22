import { execFile as execFileCallback, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RecoveryError, runRecoveryCycle } from './recovery-lib.mjs'

const execFile = promisify(execFileCallback)
const SERVICE_PATTERN = /^[A-Za-z0-9@_.-]+$/

function argumentMap(args) {
  if (args[0] !== 'cycle') throw new RecoveryError('io')
  const values = new Map()
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value == null || values.has(name.slice(2))) {
      throw new RecoveryError('io')
    }
    values.set(name.slice(2), value)
  }
  return values
}

function boundedInteger(values, { name, fallback, minimum, maximum }) {
  const raw = values.get(name)
  if (raw == null) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RecoveryError('io')
  }
  return parsed
}

function requiredRoot(values) {
  const raw = values.get('app-root')
  if (!raw || !isAbsolute(raw) || /[\r\n]/.test(raw)) throw new RecoveryError('io')
  const appRoot = resolve(raw)
  if (appRoot === parse(appRoot).root) throw new RecoveryError('io')
  return appRoot
}

export function parseRecoveryArgs(args) {
  const values = argumentMap(args)
  const appRoot = requiredRoot(values)
  const service = values.get('service') ?? 'tokember'
  if (!SERVICE_PATTERN.test(service)) throw new RecoveryError('io')
  const known = new Set(['app-root', 'service', 'keep', 'timeout-ms', 'pages', 'retries'])
  if ([...values.keys()].some(name => !known.has(name))) throw new RecoveryError('io')
  return {
    appRoot,
    service,
    keep: boundedInteger(values, { name: 'keep', fallback: 28, minimum: 1, maximum: 365 }),
    timeoutMs: boundedInteger(values, {
      name: 'timeout-ms', fallback: 600_000, minimum: 1_000, maximum: 3_600_000,
    }),
    pagesPerStep: boundedInteger(values, {
      name: 'pages', fallback: 256, minimum: 1, maximum: 4_096,
    }),
    retries: boundedInteger(values, { name: 'retries', fallback: 2, minimum: 0, maximum: 5 }),
  }
}

async function ensureBackupRoot(appRoot) {
  const backupRoot = join(appRoot, 'backups', 'periodic')
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await chmod(backupRoot, 0o700)
  return backupRoot
}

async function resolveDatabase(config) {
  try {
    const script = join(config.appRoot, 'current', 'scripts', 'resolve-tokember-db.sh')
    const result = await execFile('/usr/bin/env', ['bash', script, config.service], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    })
    const path = result.stdout.trim()
    if (!path || !isAbsolute(path) || /[\r\n]/.test(path)) throw new Error()
    return path
  } catch {
    throw new RecoveryError('io')
  }
}

function runtimeDatabase(appRoot) {
  try {
    const require = createRequire(join(appRoot, 'current', 'server', 'package.json'))
    return require('better-sqlite3')
  } catch {
    throw new RecoveryError('io')
  }
}

async function runLocked(config, backupRoot) {
  const sourcePath = await resolveDatabase(config)
  await runRecoveryCycle({
    Database: runtimeDatabase(config.appRoot),
    sourcePath,
    backupRoot,
    keep: config.keep,
    timeoutMs: config.timeoutMs,
    pagesPerStep: config.pagesPerStep,
    retries: config.retries,
    restoreSmokePath: join(config.appRoot, 'current', 'server', 'dist', 'restore-smoke.js'),
    buildMetadataPath: join(config.appRoot, 'current', 'release.json'),
  })
  process.stdout.write('recovery:ok\n')
}

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild)
    child.once('exit', code => resolveChild(code ?? 2))
  })
}

async function runWithLock(config, backupRoot) {
  const lockPath = join(backupRoot, 'recovery.lock')
  const child = spawn('/usr/bin/flock', [
    '--nonblock', lockPath,
    process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], {
    env: { ...process.env, TOKEMBER_RECOVERY_LOCKED: '1' },
    stdio: 'inherit',
  })
  const code = await waitForChild(child)
  if (code === 1) {
    process.stdout.write('recovery:already_running\n')
    return
  }
  process.exitCode = code
}

async function runCli() {
  process.umask(0o077)
  const config = parseRecoveryArgs(process.argv.slice(2))
  const backupRoot = await ensureBackupRoot(config.appRoot)
  if (process.env.TOKEMBER_RECOVERY_LOCKED !== '1') {
    await runWithLock(config, backupRoot)
    return
  }
  await runLocked(config, backupRoot)
}

export function isRecoveryMain(argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isRecoveryMain()) {
  runCli().catch(error => {
    const code = error instanceof RecoveryError ? error.code : 'io'
    process.stderr.write(`recovery:failed:${code}\n`)
    process.exitCode = 2
  })
}
