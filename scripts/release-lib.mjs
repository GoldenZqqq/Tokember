import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ARCHITECTURE_PATTERN = /^[a-z0-9_]+$/

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function runtimeDependencyVersions(lockfile) {
  const packages = lockfile?.packages
  if (!packages || typeof packages !== 'object') throw new Error('invalid root lockfile')
  return Object.fromEntries(Object.entries(packages)
    .filter(([path, item]) => path.startsWith('node_modules/')
      && item && typeof item === 'object'
      && typeof item.version === 'string'
      && item.dev !== true && item.link !== true)
    .map(([path, item]) => [path.replaceAll('\\', '/'), item.version])
    .sort(([left], [right]) => left.localeCompare(right)))
}

function requiredString(value, field, pattern) {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`invalid ${field}`)
  }
  return value
}

export function buildReleaseMetadata(input) {
  const version = requiredString(input.version, 'version', RELEASE_PATTERN)
  const commit = requiredString(input.commit?.toLowerCase(), 'commit', /^[a-f0-9]{40}$/)
  const builtAt = new Date(requiredString(input.builtAt, 'builtAt')).toISOString()
  const nodeVersion = requiredString(input.nodeVersion?.replace(/^v/, ''), 'nodeVersion')
  const architecture = requiredString(input.architecture, 'architecture', ARCHITECTURE_PATTERN)
  const lockfileText = requiredString(input.lockfileText, 'lockfileText')
  return {
    schema_version: 2,
    release_id: `${version}-${commit.slice(0, 12)}`,
    version,
    commit,
    built_at: builtAt,
    node_version: nodeVersion,
    architecture,
    lockfile_sha256: sha256(lockfileText),
    runtime_dependencies: runtimeDependencyVersions(input.lockfile),
  }
}

async function listArtifactEntries(root, current = '') {
  const entries = await readdir(join(root, current), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = current ? `${current}/${entry.name}` : entry.name
    if (path === 'SHA256SUMS') continue
    if (entry.isDirectory()) files.push(...await listArtifactEntries(root, path))
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(path)
    else throw new Error(`unsupported artifact entry: ${path}`)
  }
  return files.sort()
}

async function hashArtifactEntry(root, path) {
  const absolute = join(root, ...path.split('/'))
  const stat = await lstat(absolute)
  if (!stat.isSymbolicLink()) return sha256(await readFile(absolute))
  const target = await readlink(absolute)
  if (!isPathInside(root, resolve(dirname(absolute), target))) {
    throw new Error(`external artifact symlink: ${path}`)
  }
  return sha256(`symlink:${target}`)
}

export async function writeChecksumManifest(root) {
  const paths = await listArtifactEntries(root)
  const lines = []
  for (const path of paths) lines.push(`${await hashArtifactEntry(root, path)}  ${path}`)
  await writeFile(join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
}

function parseChecksumManifest(text) {
  const checksums = new Map()
  for (const line of text.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match || isAbsolute(match[2]) || match[2].split('/').includes('..')) {
      throw new Error('invalid checksum manifest')
    }
    if (checksums.has(match[2])) throw new Error('duplicate checksum path')
    checksums.set(match[2], match[1])
  }
  return checksums
}

export async function verifyChecksumManifest(root) {
  const checksums = parseChecksumManifest(await readFile(join(root, 'SHA256SUMS'), 'utf8'))
  const actualPaths = await listArtifactEntries(root)
  if (actualPaths.join('\n') !== [...checksums.keys()].sort().join('\n')) {
    throw new Error('artifact file list mismatch')
  }
  for (const path of actualPaths) {
    if (await hashArtifactEntry(root, path) !== checksums.get(path)) {
      throw new Error(`checksum mismatch: ${path}`)
    }
  }
}

function validRuntimeDependencies(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([path, version]) => (
      path.startsWith('node_modules/') && typeof version === 'string' && version.length > 0
    ))
}

export function validateReleaseMetadata(value) {
  if (!value || typeof value !== 'object' || value.schema_version !== 2) {
    throw new Error('invalid release metadata')
  }
  requiredString(value.release_id, 'release_id', RELEASE_PATTERN)
  requiredString(value.version, 'version', RELEASE_PATTERN)
  requiredString(value.commit, 'commit', /^[a-f0-9]{40}$/)
  if (!Number.isFinite(Date.parse(value.built_at))) throw new Error('invalid built_at')
  requiredString(value.node_version, 'node_version')
  requiredString(value.architecture, 'architecture', ARCHITECTURE_PATTERN)
  requiredString(value.lockfile_sha256, 'lockfile_sha256', HASH_PATTERN)
  if (!validRuntimeDependencies(value.runtime_dependencies)) {
    throw new Error('invalid runtime_dependencies')
  }
  return value
}

export async function readReleaseMetadata(root) {
  try {
    return validateReleaseMetadata(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('invalid release metadata')
    throw error
  }
}

function assertSafeOutput(workspaceRoot, outputDir) {
  const workspace = resolve(workspaceRoot)
  const output = resolve(outputDir)
  const safeName = /^(?:stage|release|tokember-(?:stage|release|collector)(?:-[A-Za-z0-9._-]+)?)$/
  if (output === parse(output).root || output === workspace || !safeName.test(parse(output).base)) {
    throw new Error('unsafe release output path')
  }
  return { workspace, output }
}

const COLLECTOR_RELEASE_FILES = [
  'dist/index.js',
  'diagnostics.mjs',
  'install.mjs',
  'setup-collector.ps1',
  'setup-collector.sh',
  'setup-hermes-collector.sh',
  'package.json',
]

const COLLECTOR_FORBIDDEN = new Set([
  'collector.env',
  'collector.log',
  'run-collector.cmd',
  'run-collector.vbs',
])

export function buildCollectorPackageMeta(input) {
  const version = requiredString(input.version, 'version', RELEASE_PATTERN)
  const commit = requiredString(input.commit?.toLowerCase(), 'commit', /^[a-f0-9]{40}$/)
  const builtAt = new Date(requiredString(input.builtAt, 'builtAt')).toISOString()
  return {
    schema_version: 1,
    kind: 'collector',
    version,
    commit,
    built_at: builtAt,
    node_engine: '>=22 <23',
    platforms: ['windows', 'macos', 'linux'],
    entry: 'install.mjs',
    runtime: 'dist/index.js',
    install: {
      windows: 'node install.mjs install',
      unix: 'node install.mjs install',
      upgrade: 'node install.mjs upgrade',
      doctor: 'node install.mjs doctor',
      diagnose: 'node install.mjs diagnose --output tokember-diagnostics.json',
    },
  }
}

export function buildImageManifest(input) {
  const version = requiredString(input.version, 'version', RELEASE_PATTERN)
  const commit = requiredString(input.commit?.toLowerCase(), 'commit', /^[a-f0-9]{40}$/)
  const images = Array.isArray(input.images) ? input.images : []
  if (images.length === 0) throw new Error('image manifest requires at least one image')
  for (const image of images) {
    requiredString(image.platform, 'platform', /^linux\/(amd64|arm64)$/)
    requiredString(image.tag, 'tag')
    if (image.digest != null) requiredString(image.digest, 'digest', /^sha256:[a-f0-9]{64}$/)
  }
  return {
    schema_version: 1,
    kind: 'server-image',
    release_id: `${version}-${commit.slice(0, 12)}`,
    version,
    commit,
    images,
  }
}

/**
 * Stage a multi-platform Collector source pack (dist + installers).
 * Does not include collector.env, logs, or machine-local runners.
 */
export async function stageCollectorRelease(options) {
  const { workspace, output } = assertSafeOutput(options.workspaceRoot, options.outputDir)
  const collectorRoot = join(workspace, 'collector')
  const packageJson = JSON.parse(await readFile(join(collectorRoot, 'package.json'), 'utf8'))
  const version = options.version ?? packageJson.version
  const meta = buildCollectorPackageMeta({
    version,
    commit: options.commit,
    builtAt: options.builtAt,
  })

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  for (const relative of COLLECTOR_RELEASE_FILES) {
    const base = relative.split('/').pop()
    if (COLLECTOR_FORBIDDEN.has(base)) throw new Error(`refusing forbidden collector file: ${base}`)
    await copyRequired(join(collectorRoot, ...relative.split('/')), join(output, ...relative.split('/')))
  }

  for (const name of COLLECTOR_FORBIDDEN) {
    try {
      await readFile(join(output, name))
      throw new Error(`collector package leaked forbidden file: ${name}`)
    } catch (error) {
      if (error && error.message?.startsWith('collector package leaked')) throw error
      /* expected missing */
    }
  }

  const readme = [
    'Tokember Collector release pack',
    '',
    `Version: ${meta.version}`,
    `Commit: ${meta.commit}`,
    `Node: ${meta.node_engine}`,
    '',
    'Install (from this directory, with Node 22.x):',
    '  node install.mjs install',
    'Upgrade (keeps collector.env and state):',
    '  node install.mjs upgrade',
    'Diagnose:',
    '  node install.mjs doctor',
    'Anonymous support report:',
    '  node install.mjs diagnose --output tokember-diagnostics.json',
    '',
    'Set TOKEMBER_SERVER and TOKEMBER_DEVICE_TOKEN in collector.env before production sync.',
    'See docs/release.md and docs/COMPATIBILITY.md in the repository.',
    '',
  ].join('\n')
  await writeFile(join(output, 'README-COLLECTOR.txt'), readme, 'utf8')
  await writeFile(join(output, 'package-meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  await writeChecksumManifest(output)
  await verifyChecksumManifest(output)
  return { meta, output }
}

export async function writeImageManifestFile(path, input) {
  const manifest = buildImageManifest(input)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function copyRequired(source, target, options = {}) {
  try {
    await cp(source, target, { recursive: true, ...options })
  } catch {
    throw new Error(`missing release input: ${source}`)
  }
}

async function verifyDirectRuntime(output, serverPackage, lockfile) {
  for (const name of Object.keys(serverPackage.dependencies ?? {}).sort()) {
    const lockPath = `node_modules/${name}`
    const expected = lockfile.packages?.[lockPath]?.version
    let actual
    try {
      const pkg = JSON.parse(await readFile(join(output, 'server', lockPath, 'package.json'), 'utf8'))
      actual = pkg.version
    } catch {
      throw new Error(`missing production dependency: ${name}`)
    }
    if (typeof expected !== 'string' || actual !== expected) {
      throw new Error(`runtime dependency drift: ${name}`)
    }
  }
}

async function verifyServerEntrypoints(output) {
  for (const name of ['index.js', 'restore-smoke.js']) {
    try {
      await readFile(join(output, 'server', 'dist', name))
    } catch {
      throw new Error(`missing release input: server/dist/${name}`)
    }
  }
}

function verifyNativeRuntime(output, serverPackage) {
  if (!serverPackage.dependencies?.['better-sqlite3']) return
  let database
  try {
    const require = createRequire(join(output, 'server/package.json'))
    const Database = require('better-sqlite3')
    database = new Database(':memory:')
    database.prepare('SELECT 1').get()
    database.close()
  } catch {
    try { database?.close() } catch { /* Preserve the stable smoke error. */ }
    throw new Error('native runtime smoke failed: better-sqlite3')
  }
}

function runtimeCopyFilter(source) {
  const normalized = source.replaceAll('\\', '/')
  return !normalized.endsWith('/node_modules/.bin')
    && !normalized.includes('/node_modules/@tokember/')
}

export async function stageRelease(options) {
  const { workspace, output } = assertSafeOutput(options.workspaceRoot, options.outputDir)
  const lockfileText = await readFile(join(workspace, 'package-lock.json'), 'utf8')
  const lockfile = JSON.parse(lockfileText)
  const serverPackage = JSON.parse(await readFile(join(workspace, 'server/package.json'), 'utf8'))
  const metadata = buildReleaseMetadata({
    lockfile, lockfileText, version: serverPackage.version,
    commit: options.commit, builtAt: options.builtAt, nodeVersion: options.nodeVersion,
    architecture: options.architecture ?? process.arch,
  })
  await rm(output, { recursive: true, force: true })
  await mkdir(join(output, 'server'), { recursive: true })
  await copyRequired(join(workspace, 'server/dist'), join(output, 'server/dist'))
  await verifyServerEntrypoints(output)
  await copyRequired(join(workspace, 'server/package.json'), join(output, 'server/package.json'))
  await copyRequired(join(workspace, 'web/dist'), join(output, 'web'))
  await copyRequired(join(workspace, 'node_modules'), join(output, 'server/node_modules'), {
    filter: runtimeCopyFilter,
    verbatimSymlinks: true,
  })
  await verifyDirectRuntime(output, serverPackage, lockfile)
  verifyNativeRuntime(output, serverPackage)
  await mkdir(join(output, 'scripts'), { recursive: true })
  for (const name of [
    'healthcheck.mjs',
    'host-files.mjs',
    'publish-release.mjs',
    'recovery-lib.mjs',
    'recovery-units.mjs',
    'recovery.mjs',
    'release-lib.mjs',
  ]) {
    await copyRequired(join(workspace, 'scripts', name), join(output, 'scripts', name))
  }
  await copyRequired(
    join(workspace, 'scripts/resolve-tokember-db.sh'),
    join(output, 'scripts/resolve-tokember-db.sh'),
  )
  await writeFile(join(output, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  await writeChecksumManifest(output)
  await verifyChecksumManifest(output)
  return metadata
}

export function isPathInside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate))
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
