import { execFile as execFileCallback } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  isPathInside,
  readReleaseMetadata,
  verifyChecksumManifest,
  writeChecksumManifest,
} from './release-lib.mjs'
import { atomicWrite, privilegedWrite } from './host-files.mjs'
import { configureRecoveryUnits } from './recovery-units.mjs'

const execFile = promisify(execFileCallback)
const SERVICE_PATTERN = /^[A-Za-z0-9@_.-]+$/

function safeMessage(error, config = {}) {
  let message = error instanceof Error ? error.message : 'unknown failure'
  for (const secret of [config.apiKey, config.adminPassword, config.adminSecret]) {
    if (secret) message = message.replaceAll(secret, '[redacted]')
  }
  return message.replace(/Authorization\s*:[^\r\n]*/gi, 'Authorization: [redacted]').slice(0, 300)
}

export async function publishRelease(config, operations) {
  let release
  let previous
  let stopped = false
  let switched = false
  try {
    release = await operations.prepareRelease(config)
    previous = await operations.ensurePreviousRelease(config)
    const dbPath = await operations.resolveDatabase(config)
    await operations.configureRuntime(config)
    await operations.disableSub2Api(config)
    stopped = true
    await operations.stopService(config)
    const backupPath = await operations.backupDatabase(config, dbPath)
    switched = true
    await operations.switchCurrent(config, release)
    await operations.startService(config)
    await operations.waitReady(config, release)
    await operations.verifyBrowserOrigin(config, release)
    await operations.configureRecovery(config)
    return {
      release_id: release.releaseId,
      previous_release_id: previous.releaseId,
      backup_path: backupPath,
    }
  } catch (error) {
    const failure = safeMessage(error, config)
    if (!stopped || !release || !previous) throw new Error(failure)
    try {
      if (switched) await operations.switchCurrent(config, previous)
      await operations.startService(config)
      await operations.waitReady(config, previous)
      await operations.verifyBrowserOrigin(config, previous)
    } catch (rollbackError) {
      throw new Error(
        `release ${release.releaseId} failed (${failure}); rollback to ${previous.releaseId} also failed: ${safeMessage(rollbackError, config)}`,
      )
    }
    const message = switched
      ? `release ${release.releaseId} failed (${failure}); rolled back to ${previous.releaseId}`
      : `release ${release.releaseId} failed before switch (${failure}); previous ${previous.releaseId} restarted`
    throw new Error(message)
  }
}

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

async function exists(path) {
  try { await lstat(path); return true } catch { return false }
}

async function defaultRun(command, args = [], options = {}) {
  try {
    const result = await execFile(command, args, { encoding: 'utf8' })
    return result.stdout.trim()
  } catch {
    if (options.ignoreFailure) return ''
    throw new Error(`${basename(command)} failed`)
  }
}

async function atomicSymlink(linkPath, targetPath) {
  const temporary = `${linkPath}.tmp-${process.pid}`
  await rm(temporary, { force: true })
  await symlink(targetPath, temporary, 'dir')
  await rename(temporary, linkPath)
}

function releaseTarget(appRoot, releaseId) {
  const releasesRoot = join(appRoot, 'releases')
  const target = join(releasesRoot, releaseId)
  if (!isPathInside(releasesRoot, target)) throw new Error('unsafe release target')
  return { releasesRoot, target }
}

function publicWebTarget(config, releaseId) {
  const siteRoot = dirname(config.webTarget)
  const releasesRoot = join(siteRoot, '.tokember-releases')
  const target = join(releasesRoot, releaseId)
  if (!isPathInside(releasesRoot, target)) throw new Error('unsafe public web target')
  return { releasesRoot, target }
}

function relativeWebLink(config, target) {
  const link = relative(dirname(config.webTarget), target.webPath)
  if (!link || isAbsolute(link) || link.split(/[\\/]/).includes('..')) {
    throw new Error('unsafe public web link')
  }
  return link.replaceAll('\\', '/')
}

async function writeVersionedWebManifest(releasePath, publicPath) {
  const manifest = await readFile(join(releasePath, 'SHA256SUMS'), 'utf8')
  const lines = manifest.trim().split('\n').flatMap(line => {
    const match = /^([a-f0-9]{64})  web\/(.+)$/.exec(line)
    return match ? [`${match[1]}  ${match[2]}`] : []
  })
  if (!lines.length) throw new Error('release web manifest missing')
  await writeFile(join(publicPath, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
}

async function materializePublicWeb(config, release) {
  const { releasesRoot, target } = publicWebTarget(config, release.releaseId)
  await mkdir(releasesRoot, { recursive: true })
  if (await exists(target)) {
    await verifyChecksumManifest(target)
    return { ...release, webPath: target }
  }
  const incoming = `${target}.incoming-${process.pid}`
  await rm(incoming, { recursive: true, force: true })
  try {
    await cp(join(release.releasePath, 'web'), incoming, {
      recursive: true, verbatimSymlinks: true,
    })
    if (release.legacy) await writeChecksumManifest(incoming)
    else await writeVersionedWebManifest(release.releasePath, incoming)
    await verifyChecksumManifest(incoming)
    await rename(incoming, target)
  } catch {
    await rm(incoming, { recursive: true, force: true })
    throw new Error('public web materialization failed')
  }
  return { ...release, webPath: target }
}

async function materializeRelease(config) {
  await verifyChecksumManifest(config.sourceDir)
  const metadata = await readReleaseMetadata(config.sourceDir)
  const runtimeArchitecture = config.runtimeArchitecture ?? process.arch
  if (metadata.architecture !== runtimeArchitecture) {
    throw new Error(
      `release architecture ${metadata.architecture} does not match host ${runtimeArchitecture}`,
    )
  }
  const { releasesRoot, target } = releaseTarget(config.appRoot, metadata.release_id)
  await mkdir(releasesRoot, { recursive: true })
  let release
  if (await exists(target)) {
    await verifyChecksumManifest(target)
    const current = await readReleaseMetadata(target)
    if (current.commit !== metadata.commit) throw new Error('release id collision')
    release = { releaseId: metadata.release_id, releasePath: target, legacy: false }
  } else {
    const incoming = `${target}.incoming-${process.pid}`
    if (!isPathInside(releasesRoot, incoming)) throw new Error('unsafe incoming release path')
    await rm(incoming, { recursive: true, force: true })
    try {
      await cp(config.sourceDir, incoming, { recursive: true, verbatimSymlinks: true })
      await verifyChecksumManifest(incoming)
      await rename(incoming, target)
    } catch {
      await rm(incoming, { recursive: true, force: true })
      throw new Error('release materialization failed')
    }
    release = { releaseId: metadata.release_id, releasePath: target, legacy: false }
  }
  return materializePublicWeb(config, release)
}

async function readCurrentRelease(config) {
  const currentPath = join(config.appRoot, 'current')
  if (!await exists(currentPath)) return null
  const releasePath = await realpath(currentPath)
  if (!isPathInside(join(config.appRoot, 'releases'), releasePath)) {
    throw new Error('current release points outside releases root')
  }
  let release
  try {
    const metadata = await readReleaseMetadata(releasePath)
    release = { releaseId: metadata.release_id, releasePath, legacy: false }
  } catch {
    release = { releaseId: basename(releasePath), releasePath, legacy: true }
  }
  return materializePublicWeb(config, release)
}

async function findLegacyServerDir(config, run) {
  if (config.legacyServerDir) return config.legacyServerDir
  const working = await run('systemctl', [
    'show', config.service, '-p', 'WorkingDirectory', '--value',
  ])
  return working || join(config.appRoot, 'server')
}

async function copyLegacyRuntime(config, releasePath, run) {
  const source = await findLegacyServerDir(config, run)
  if (!isPathInside(config.appRoot, source)) throw new Error('legacy server path is outside app root')
  if (!await exists(source)) throw new Error('legacy server directory not found')
  await cp(source, join(releasePath, 'server'), { recursive: true, verbatimSymlinks: true })
  const runtimeTarget = join(releasePath, 'server/node_modules')
  if (await exists(runtimeTarget)) return
  for (const candidate of [join(dirname(source), 'node_modules'), join(config.appRoot, 'node_modules')]) {
    if (await exists(candidate)) {
      await cp(candidate, runtimeTarget, { recursive: true, verbatimSymlinks: true })
      return
    }
  }
  throw new Error('legacy runtime dependencies not found')
}

async function ensureWebLink(config, target) {
  const backup = `${config.webTarget}.pre-release-${target.releaseId}`
  if (await exists(config.webTarget)) {
    const info = await lstat(config.webTarget)
    if (info.isSymbolicLink()) {
      if (await realpath(config.webTarget) === target.webPath) return
    }
    await rename(config.webTarget, backup)
  }
  await atomicSymlink(config.webTarget, relativeWebLink(config, target))
}

async function bootstrapLegacyRelease(config, run) {
  const releaseId = `legacy-${timestamp()}-${process.pid}`
  const { releasesRoot, target } = releaseTarget(config.appRoot, releaseId)
  await mkdir(releasesRoot, { recursive: true })
  await mkdir(target, { recursive: true })
  await copyLegacyRuntime(config, target, run)
  const webSource = await realpath(config.webTarget)
  await cp(webSource, join(target, 'web'), { recursive: true, verbatimSymlinks: true })
  await writeFile(join(target, 'legacy-release.json'), `${JSON.stringify({ release_id: releaseId })}\n`)
  const release = await materializePublicWeb(config, {
    releaseId, releasePath: target, legacy: true,
  })
  await atomicSymlink(join(config.appRoot, 'current'), target)
  await ensureWebLink(config, release)
  return release
}

async function switchRelease(config, target) {
  await atomicSymlink(join(config.appRoot, 'current'), target.releasePath)
  await atomicSymlink(config.webTarget, relativeWebLink(config, target))
}

function secretLine(value, name) {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) {
    throw new Error(`invalid ${name}`)
  }
  return value
}

function systemdValue(value, name) {
  return `"${secretLine(value, name).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function optionalRuntimeValue(value, name) {
  return value ? `${name}=${systemdValue(value, name)}` : null
}

function primaryCorsOrigin(config) {
  const value = config.corsOrigins?.split(',')[0]?.trim()
  if (!value) {
    if (config.trustProxy === 'true') {
      throw new Error('TOKEMBER_CORS_ORIGINS is required when TOKEMBER_TRUST_PROXY=true')
    }
    return null
  }
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) throw new Error()
    return url.origin
  } catch {
    throw new Error('TOKEMBER_CORS_ORIGINS must start with an exact HTTP(S) origin')
  }
}

async function configureRuntime(config, run) {
  primaryCorsOrigin(config)
  const apiKey = systemdValue(config.apiKey, 'TOKEMBER_API_KEY')
  const password = systemdValue(config.adminPassword, 'TOKEMBER_ADMIN_PASSWORD')
  const optional = [
    optionalRuntimeValue(config.adminSecret, 'TOKEMBER_ADMIN_SECRET'),
    optionalRuntimeValue(config.adminPreviousSecret, 'TOKEMBER_ADMIN_SECRET_PREVIOUS'),
    optionalRuntimeValue(config.viewerPassword, 'TOKEMBER_VIEWER_PASSWORD'),
    optionalRuntimeValue(config.viewerSecret, 'TOKEMBER_VIEWER_SECRET'),
    optionalRuntimeValue(config.viewerPreviousSecret, 'TOKEMBER_VIEWER_SECRET_PREVIOUS'),
    optionalRuntimeValue(config.authAuditSecret, 'TOKEMBER_AUTH_AUDIT_SECRET'),
    optionalRuntimeValue(config.corsOrigins, 'TOKEMBER_CORS_ORIGINS'),
    optionalRuntimeValue(config.trustProxy, 'TOKEMBER_TRUST_PROXY'),
    optionalRuntimeValue(config.cookieSameSite, 'TOKEMBER_COOKIE_SAME_SITE'),
    optionalRuntimeValue(config.cookieSecure, 'TOKEMBER_COOKIE_SECURE'),
    optionalRuntimeValue(config.allowLegacyApiKey, 'TOKEMBER_ALLOW_LEGACY_API_KEY'),
    optionalRuntimeValue(config.alertWebhookUrl, 'TOKEMBER_ALERT_WEBHOOK_URL'),
    optionalRuntimeValue(config.alertWebhookSecret, 'TOKEMBER_ALERT_WEBHOOK_SECRET'),
  ].filter(Boolean)
  await atomicWrite(config.runtimeEnv, [
    `TOKEMBER_API_KEY=${apiKey}`,
    `TOKEMBER_ADMIN_PASSWORD=${password}`,
    ...optional,
    '',
  ].join('\n'), 0o600)
  const dropin = [
    '[Service]',
    `WorkingDirectory=${join(config.appRoot, 'current/server')}`,
    'ExecStart=',
    `ExecStart=/usr/bin/env node ${join(config.appRoot, 'current/server/dist/index.js')}`,
    'Environment=NODE_ENV=production',
    `Environment=TOKEMBER_BUILD_METADATA=${join(config.appRoot, 'current/release.json')}`,
    `Environment=TOKEMBER_RECOVERY_STATUS_PATH=${systemdValue(
      join(config.appRoot, 'backups/periodic/status.json'),
      'TOKEMBER_RECOVERY_STATUS_PATH',
    )}`,
    `EnvironmentFile=-${config.runtimeEnv}`,
    '',
  ].join('\n')
  const usedSudo = await privilegedWrite(config.dropinPath, dropin, {
    run, appRoot: config.appRoot,
  })
  if (usedSudo) await run('sudo', ['systemctl', 'daemon-reload'])
  else await run('systemctl', ['daemon-reload'])
}

async function backupDatabase(config, dbPath) {
  await stat(dbPath)
  const backupPath = join(config.appRoot, 'backups', `${timestamp()}-${process.pid}`)
  await mkdir(backupPath, { recursive: true })
  await copyFile(dbPath, join(backupPath, 'tokember.db'))
  for (const suffix of ['-wal', '-shm']) {
    if (await exists(`${dbPath}${suffix}`)) {
      await copyFile(`${dbPath}${suffix}`, join(backupPath, `tokember.db${suffix}`))
    }
  }
  return backupPath
}

async function waitReady(config, target, dependencies) {
  const { fetchImpl, sleep } = dependencies
  const url = target.legacy ? config.legacyReadyUrl : config.readyUrl
  for (let attempt = 0; attempt < config.healthAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) })
      if (target.legacy && response.ok) return
      const body = await response.json()
      if (response.ok && body.status === 'ready' && body.release_id === target.releaseId) return
    } catch {
      // Retry only; never expose response bodies or transport details.
    }
    await sleep(config.healthIntervalMs)
  }
  throw new Error(`readiness failed for ${target.releaseId}`)
}

async function verifyBrowserOrigin(config, target, dependencies) {
  const origin = primaryCorsOrigin(config)
  if (!origin) return
  const { fetchImpl, sleep } = dependencies
  for (let attempt = 0; attempt < config.healthAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${origin}/api/auth/session`, {
        headers: { Origin: origin },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      })
      if (response.ok && response.headers.get('access-control-allow-origin') === origin) return
    } catch {
      // Retry without exposing public response bodies or transport details.
    }
    await sleep(config.healthIntervalMs)
  }
  throw new Error(`browser origin smoke failed for ${target.releaseId}`)
}

async function changeUnitIfPresent(run, unit, args) {
  const state = await run('systemctl', [
    'show', unit, '-p', 'LoadState', '--value',
  ], { ignoreFailure: true })
  if (!state || state === 'not-found') return
  await run('systemctl', [...args, unit])
}

async function disableSub2Api(run) {
  for (const unit of ['tokember-sub2api.timer', 'ai-burn-sub2api.timer']) {
    await changeUnitIfPresent(run, unit, ['disable', '--now'])
  }
  for (const unit of ['tokember-sub2api.service', 'ai-burn-sub2api.service']) {
    await changeUnitIfPresent(run, unit, ['stop'])
  }
}

export function createHostOperations(dependencies = {}) {
  const run = dependencies.run ?? defaultRun
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  return {
    prepareRelease: materializeRelease,
    ensurePreviousRelease: async config => (
      await readCurrentRelease(config) ?? bootstrapLegacyRelease(config, run)
    ),
    resolveDatabase: async config => {
      const script = join(config.sourceDir, 'scripts/resolve-tokember-db.sh')
      await chmod(script, 0o755)
      return run(script, [config.service])
    },
    configureRuntime: config => configureRuntime(config, run),
    disableSub2Api: () => disableSub2Api(run),
    stopService: config => run('systemctl', ['stop', config.service]),
    backupDatabase,
    switchCurrent: switchRelease,
    startService: config => run('systemctl', ['restart', config.service]),
    waitReady: (config, target) => waitReady(config, target, { fetchImpl, sleep }),
    verifyBrowserOrigin: (config, target) => verifyBrowserOrigin(
      config, target, { fetchImpl, sleep },
    ),
    configureRecovery: config => configureRecoveryUnits(config, run),
    log: dependencies.log ?? console.log,
  }
}

function argumentMap(args) {
  const result = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] == null) {
      throw new Error('invalid publish arguments')
    }
    result.set(args[index].slice(2), args[index + 1])
  }
  return result
}

function requiredArgument(args, name) {
  const value = args.get(name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

async function runCli() {
  const args = argumentMap(process.argv.slice(2))
  const service = args.get('service') ?? 'tokember'
  if (!SERVICE_PATTERN.test(service)) throw new Error('invalid service')
  const appRoot = resolve(requiredArgument(args, 'app-root'))
  const config = {
    sourceDir: resolve(requiredArgument(args, 'source')),
    appRoot,
    webTarget: resolve(requiredArgument(args, 'web-target')),
    service,
    legacyServerDir: args.get('legacy-server') ? resolve(args.get('legacy-server')) : undefined,
    runtimeEnv: join(appRoot, 'runtime.env'),
    dropinPath: `/etc/systemd/system/${service}.service.d/release.conf`,
    readyUrl: args.get('ready-url') ?? 'http://127.0.0.1:3147/api/health/ready',
    legacyReadyUrl: args.get('legacy-ready-url') ?? 'http://127.0.0.1:3147/api/stats?days=7',
    healthAttempts: Number(args.get('health-attempts') ?? 20),
    healthIntervalMs: Number(args.get('health-interval-ms') ?? 1_000),
    runtimeArchitecture: process.arch,
    apiKey: process.env.TOKEMBER_API_KEY,
    adminPassword: process.env.TOKEMBER_ADMIN_PASSWORD,
    adminSecret: process.env.TOKEMBER_ADMIN_SECRET,
    adminPreviousSecret: process.env.TOKEMBER_ADMIN_SECRET_PREVIOUS,
    viewerPassword: process.env.TOKEMBER_VIEWER_PASSWORD,
    viewerSecret: process.env.TOKEMBER_VIEWER_SECRET,
    viewerPreviousSecret: process.env.TOKEMBER_VIEWER_SECRET_PREVIOUS,
    authAuditSecret: process.env.TOKEMBER_AUTH_AUDIT_SECRET,
    corsOrigins: process.env.TOKEMBER_CORS_ORIGINS,
    trustProxy: process.env.TOKEMBER_TRUST_PROXY,
    cookieSameSite: process.env.TOKEMBER_COOKIE_SAME_SITE,
    cookieSecure: process.env.TOKEMBER_COOKIE_SECURE,
    allowLegacyApiKey: process.env.TOKEMBER_ALLOW_LEGACY_API_KEY,
    alertWebhookUrl: process.env.TOKEMBER_ALERT_WEBHOOK_URL,
    alertWebhookSecret: process.env.TOKEMBER_ALERT_WEBHOOK_SECRET,
  }
  const result = await publishRelease(config, createHostOperations())
  console.log(`Published ${result.release_id}`)
  console.log(`Previous release: ${result.previous_release_id}`)
  console.log('SQLite release backup retained')
}

function isMainModule(argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  runCli().catch(error => {
    console.error(`Publish failed: ${safeMessage(error)}`)
    process.exitCode = 1
  })
}
