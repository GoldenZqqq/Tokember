import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildCollectorPackageMeta,
  buildImageManifest,
  buildReleaseMetadata,
  stageCollectorRelease,
  stageRelease,
  verifyChecksumManifest,
  writeChecksumManifest,
} from './release-lib.mjs'
import { createHostOperations, publishRelease } from './publish-release.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const BUILT_AT = '2026-07-17T00:00:00.000Z'

const RECOVERY_SCRIPT_FIXTURES = {
  'scripts/healthcheck.mjs': '',
  'scripts/host-files.mjs': '',
  'scripts/publish-release.mjs': '',
  'scripts/recovery-lib.mjs': '',
  'scripts/recovery-units.mjs': '',
  'scripts/recovery.mjs': '',
  'scripts/release-lib.mjs': '',
  'scripts/resolve-tokember-db.sh': '#!/bin/sh',
}

function lockFixture() {
  return {
    packages: {
      'node_modules/hono': { version: '4.12.29' },
      'node_modules/better-sqlite3': { version: '11.10.0' },
      'node_modules/tsx': { version: '4.19.4', dev: true },
      'node_modules/@tokember/server': { resolved: 'server', link: true },
    },
  }
}

/** Compare filesystem paths after realpath (macOS maps /var → /private/var). */
async function assertSamePath(actual, expected) {
  assert.equal(await realpath(actual), await realpath(expected))
}

async function writeFixtureFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

async function readOptionalFile(url) {
  try {
    return await readFile(url, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  }))
  return nested.flat()
}

test('Web source files are not hidden by Git ignore rules', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const files = (await collectFiles(join(root, 'web', 'src')))
    .map(path => relative(root, path).replaceAll('\\', '/'))
  const check = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: `${files.join('\n')}\n`,
  })
  const ignored = check.stdout.trim()
  assert.equal(check.status, 1, ignored
    ? `Web source files are ignored and may be absent from CI:\n${ignored}`
    : check.stderr)
})

test('release metadata is deterministic and excludes dev/workspace links', () => {
  const input = {
    lockfile: lockFixture(),
    lockfileText: '{"lockfileVersion":3}',
    version: '0.1.0',
    commit: COMMIT,
    builtAt: BUILT_AT,
    nodeVersion: '22.17.0',
    architecture: 'arm64',
  }
  const first = buildReleaseMetadata(input)
  const second = buildReleaseMetadata(structuredClone(input))
  assert.deepEqual(first, second)
  assert.equal(first.schema_version, 2)
  assert.equal(first.release_id, '0.1.0-0123456789ab')
  assert.equal(first.architecture, 'arm64')
  assert.throws(
    () => buildReleaseMetadata({ ...input, architecture: '../arm64' }),
    /invalid architecture/,
  )
  assert.deepEqual(first.runtime_dependencies, {
    'node_modules/better-sqlite3': '11.10.0',
    'node_modules/hono': '4.12.29',
  })
  assert.match(first.lockfile_sha256, /^[a-f0-9]{64}$/)
})

test('checksum manifest is sorted and detects artifact tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-release-'))
  try {
    await mkdir(join(root, 'server', 'dist'), { recursive: true })
    await writeFile(join(root, 'release.json'), '{}', 'utf8')
    await writeFile(join(root, 'server', 'dist', 'index.js'), 'export {}', 'utf8')
    await writeFile(join(root, 'server', 'dist', 'restore-smoke.js'), 'export {}', 'utf8')
    await writeChecksumManifest(root)
    const manifest = await readFile(join(root, 'SHA256SUMS'), 'utf8')
    assert.deepEqual(manifest.trim().split('\n').map(line => line.split('  ')[1]), [
      'release.json', 'server/dist/index.js', 'server/dist/restore-smoke.js',
    ])
    await verifyChecksumManifest(root)
    await writeFile(join(root, 'server', 'dist', 'index.js'), 'tampered', 'utf8')
    await assert.rejects(() => verifyChecksumManifest(root), /checksum mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('canonical staging includes built server web runtime metadata and checksums', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tokember-workspace-'))
  const output = join(workspace, '..', `tokember-stage-${process.pid}-${Date.now()}`)
  try {
    const files = {
      'package-lock.json': JSON.stringify(lockFixture()),
      'server/package.json': JSON.stringify({
        version: '0.1.0',
        dependencies: { hono: '^4.7.0', 'better-sqlite3': '^11.8.0' },
      }),
      'server/dist/index.js': 'export {}',
      'server/dist/restore-smoke.js': 'export {}',
      'web/dist/index.html': '<main>Tokember</main>',
      'node_modules/hono/package.json': JSON.stringify({ name: 'hono', version: '4.12.29' }),
      'node_modules/better-sqlite3/package.json': JSON.stringify({
        name: 'better-sqlite3', version: '11.10.0', main: 'index.js',
      }),
      'node_modules/better-sqlite3/index.js': `module.exports = class Database {
        prepare() { return { get() { return { ok: 1 } } } }
        close() {}
      }`,
      ...RECOVERY_SCRIPT_FIXTURES,
    }
    await writeFixtureFiles(workspace, files)
    const metadata = await stageRelease({
      workspaceRoot: workspace,
      outputDir: output,
      commit: COMMIT,
      builtAt: BUILT_AT,
      nodeVersion: '22.17.0',
      architecture: 'arm64',
    })
    assert.equal(metadata.release_id, '0.1.0-0123456789ab')
    assert.equal(metadata.architecture, 'arm64')
    assert.equal(JSON.parse(await readFile(join(output, 'release.json'))).commit, COMMIT)
    assert.equal(
      JSON.parse(await readFile(join(output, 'server/node_modules/hono/package.json'))).version,
      '4.12.29',
    )
    assert.equal(await readFile(join(output, 'scripts/recovery.mjs'), 'utf8'), '')
    assert.equal(await readFile(join(output, 'server/dist/restore-smoke.js'), 'utf8'), 'export {}')
    await verifyChecksumManifest(output)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(output, { recursive: true, force: true })
  }
})

test('canonical staging rejects an unloadable native database without leaking details', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tokember-native-'))
  const output = join(workspace, '..', `tokember-stage-native-${process.pid}-${Date.now()}`)
  try {
    await writeFixtureFiles(workspace, {
      'package-lock.json': JSON.stringify(lockFixture()),
      'server/package.json': JSON.stringify({
        version: '0.1.0', dependencies: { 'better-sqlite3': '^11.8.0' },
      }),
      'server/dist/index.js': 'export {}',
      'server/dist/restore-smoke.js': 'export {}',
      'web/dist/index.html': '<main>Tokember</main>',
      'node_modules/better-sqlite3/package.json': JSON.stringify({
        name: 'better-sqlite3', version: '11.10.0', main: 'index.js',
      }),
      'node_modules/better-sqlite3/index.js': "throw new Error('secret native loader detail')",
      ...RECOVERY_SCRIPT_FIXTURES,
    })
    await assert.rejects(() => stageRelease({
      workspaceRoot: workspace,
      outputDir: output,
      commit: COMMIT,
      builtAt: BUILT_AT,
      nodeVersion: '22.17.0',
      architecture: 'arm64',
    }), error => {
      assert.match(error.message, /native runtime smoke failed: better-sqlite3/)
      assert.doesNotMatch(error.message, /secret native loader detail/)
      return true
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(output, { recursive: true, force: true })
  }
})

function fakePublisher(options = {}) {
  const events = []
  const operations = {
    prepareRelease: async () => {
      events.push('prepare')
      return { releaseId: 'new', releasePath: '/releases/new' }
    },
    ensurePreviousRelease: async () => {
      events.push('previous')
      return { releaseId: 'old', releasePath: '/releases/old' }
    },
    resolveDatabase: async () => { events.push('resolve-db'); return '/data/tokember.db' },
    configureRuntime: async () => { events.push('configure') },
    disableSub2Api: async () => { events.push('disable-sub2api') },
    stopService: async () => { events.push('stop') },
    backupDatabase: async () => {
      events.push('backup')
      if (options.backupFails) throw new Error('backup failed')
      return '/backups/one'
    },
    switchCurrent: async (_config, target) => {
      events.push(`switch:${target.releaseId}`)
      if (target.releaseId === 'new' && options.switchFails) throw new Error('web switch failed')
    },
    startService: async () => { events.push('start') },
    waitReady: async (_config, target) => {
      events.push(`ready:${target.releaseId}`)
      if (target.releaseId === 'new' && options.newReadyFails) {
        throw new Error(options.newReadyMessage ?? 'not ready')
      }
      if (target.releaseId === 'old' && options.oldReadyFails) throw new Error('rollback failed')
    },
    verifyBrowserOrigin: async (_config, target) => {
      events.push(`browser:${target.releaseId}`)
      if (target.releaseId === 'new' && options.browserSmokeFails) {
        throw new Error('browser origin smoke failed')
      }
    },
    configureRecovery: async () => {
      events.push('configure-recovery')
      if (options.recoveryFails) throw new Error('recovery units failed')
    },
    log: message => events.push(`log:${message}`),
  }
  return { events, operations }
}

test('publisher backs up before switching and verifies the new release', async () => {
  const { events, operations } = fakePublisher()
  const result = await publishRelease({ service: 'tokember' }, operations)
  assert.equal(result.release_id, 'new')
  assert.ok(events.indexOf('backup') < events.indexOf('switch:new'))
  assert.deepEqual(events.slice(-5), [
    'switch:new', 'start', 'ready:new', 'browser:new', 'configure-recovery',
  ])
})

test('publisher readiness failure restores and verifies the previous release', async () => {
  const { events, operations } = fakePublisher({ newReadyFails: true })
  await assert.rejects(
    () => publishRelease({ service: 'tokember' }, operations),
    /release new failed \(not ready\); rolled back to old/,
  )
  assert.deepEqual(events.filter(event => event.startsWith('switch:')), [
    'switch:new', 'switch:old',
  ])
  assert.deepEqual(events.slice(-4), ['switch:old', 'start', 'ready:old', 'browser:old'])
  assert.equal(events.some(event => event.includes('restore-db')), false)
})

test('backup failure restarts previous without switching or restoring the database', async () => {
  const { events, operations } = fakePublisher({ backupFails: true })
  await assert.rejects(
    () => publishRelease({ service: 'tokember' }, operations),
    /release new failed before switch \(backup failed\); previous old restarted/,
  )
  assert.equal(events.some(event => event.startsWith('switch:')), false)
  assert.deepEqual(events.slice(-3), ['start', 'ready:old', 'browser:old'])
  assert.equal(events.some(event => event.includes('restore-db')), false)
})

test('recovery unit failure rolls back code without restoring the database', async () => {
  const { events, operations } = fakePublisher({ recoveryFails: true })
  await assert.rejects(
    () => publishRelease({ service: 'tokember' }, operations),
    /release new failed \(recovery units failed\); rolled back to old/,
  )
  assert.deepEqual(events.filter(event => event.startsWith('switch:')), [
    'switch:new', 'switch:old',
  ])
  assert.equal(events.some(event => event.includes('restore-db')), false)
})

test('a partial release switch failure still restores the previous release', async () => {
  const { events, operations } = fakePublisher({ switchFails: true })
  await assert.rejects(
    () => publishRelease({ service: 'tokember' }, operations),
    /release new failed \(web switch failed\); rolled back to old/,
  )
  assert.deepEqual(events.filter(event => event.startsWith('switch:')), [
    'switch:new', 'switch:old',
  ])
  assert.deepEqual(events.slice(-4), ['switch:old', 'start', 'ready:old', 'browser:old'])
})

test('publisher rolls back when the public browser origin smoke fails', async () => {
  const { events, operations } = fakePublisher({ browserSmokeFails: true })
  await assert.rejects(
    () => publishRelease({ service: 'tokember' }, operations),
    /release new failed \(browser origin smoke failed\); rolled back to old/,
  )
  assert.deepEqual(events.filter(event => event.startsWith('switch:')), [
    'switch:new', 'switch:old',
  ])
  assert.deepEqual(events.slice(-4), ['switch:old', 'start', 'ready:old', 'browser:old'])
})

test('publisher reports a failed rollback without exposing secret input', async () => {
  const { operations } = fakePublisher({ newReadyFails: true, oldReadyFails: true })
  await assert.rejects(
    () => publishRelease({ service: 'tokember', apiKey: 'secret-write-key' }, operations),
    error => {
      assert.match(error.message, /rollback to old also failed/)
      assert.doesNotMatch(error.message, /secret-write-key/)
      return true
    },
  )
})

test('publisher preserves a safe failure cause while redacting configured secrets', async () => {
  const { operations } = fakePublisher({
    newReadyFails: true,
    newReadyMessage: 'readiness failed for secret-write-key',
  })
  await assert.rejects(
    () => publishRelease({ service: 'tokember', apiKey: 'secret-write-key' }, operations),
    error => {
      assert.match(error.message, /readiness failed for \[redacted\]/)
      assert.doesNotMatch(error.message, /secret-write-key/)
      return true
    },
  )
})

test('host operations back up the main database and existing WAL/SHM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-host-'))
  try {
    const db = join(root, 'tokember.db')
    await writeFile(db, 'db', 'utf8')
    await writeFile(`${db}-wal`, 'wal', 'utf8')
    await writeFile(`${db}-shm`, 'shm', 'utf8')
    const operations = createHostOperations()
    const backup = await operations.backupDatabase({
      appRoot: root, releaseIdHint: 'fixture',
    }, db)
    assert.equal(await readFile(join(backup, 'tokember.db'), 'utf8'), 'db')
    assert.equal(await readFile(join(backup, 'tokember.db-wal'), 'utf8'), 'wal')
    assert.equal(await readFile(join(backup, 'tokember.db-shm'), 'utf8'), 'shm')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host rejects a mismatched release architecture before materializing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-architecture-'))
  const source = join(root, 'source')
  try {
    await mkdir(source)
    const metadata = buildReleaseMetadata({
      lockfile: lockFixture(),
      lockfileText: '{"lockfileVersion":3}',
      version: '0.1.0',
      commit: COMMIT,
      builtAt: BUILT_AT,
      nodeVersion: '22.17.0',
      architecture: 'x64',
    })
    await writeFile(join(source, 'release.json'), `${JSON.stringify(metadata)}\n`, 'utf8')
    await writeChecksumManifest(source)
    const operations = createHostOperations()
    await assert.rejects(() => operations.prepareRelease({
      sourceDir: source,
      appRoot: root,
      runtimeArchitecture: 'arm64',
    }), /release architecture x64 does not match host arm64/)
    await assert.rejects(() => lstat(join(root, 'releases')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host runtime config quotes secrets and reloads systemd without logging values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-runtime-'))
  const calls = []
  try {
    const operations = createHostOperations({
      run: async (command, args) => { calls.push([command, ...args]); return '' },
    })
    const runtimeEnv = join(root, 'runtime.env')
    const dropinPath = join(root, 'systemd', 'release.conf')
    await operations.configureRuntime({
      appRoot: root,
      runtimeEnv,
      dropinPath,
      apiKey: 'write"key\\value',
      adminPassword: 'admin password',
      adminSecret: 'session-secret',
      adminPreviousSecret: 'previous-session-secret',
      viewerPassword: 'viewer password',
      viewerSecret: 'viewer-secret',
      authAuditSecret: 'audit-secret',
      corsOrigins: 'https://viewer.example',
      trustProxy: 'true',
      cookieSameSite: 'none',
      cookieSecure: 'true',
      allowLegacyApiKey: 'false',
      alertWebhookUrl: 'https://alerts.example.test/hook?value="safe"',
      alertWebhookSecret: 'alert-secret',
    })
    const envFile = await readFile(runtimeEnv, 'utf8')
    assert.match(envFile, /TOKEMBER_API_KEY="write\\"key\\\\value"/)
    assert.match(envFile, /TOKEMBER_ADMIN_PASSWORD="admin password"/)
    assert.match(envFile, /TOKEMBER_VIEWER_PASSWORD="viewer password"/)
    assert.match(envFile, /TOKEMBER_AUTH_AUDIT_SECRET="audit-secret"/)
    assert.match(envFile, /TOKEMBER_CORS_ORIGINS="https:\/\/viewer\.example"/)
    assert.match(envFile, /TOKEMBER_ALLOW_LEGACY_API_KEY="false"/)
    assert.match(envFile, /TOKEMBER_ALERT_WEBHOOK_URL="https:\/\/alerts\.example\.test/)
    assert.match(envFile, /TOKEMBER_ALERT_WEBHOOK_SECRET="alert-secret"/)
    const dropin = await readFile(dropinPath, 'utf8')
    assert.match(
      dropin,
      /TOKEMBER_RECOVERY_STATUS_PATH=".*backups[\\/]+periodic[\\/]+status\.json"/,
    )
    assert.doesNotMatch(dropin, /write\\"key|admin password|alert-secret/)
    assert.deepEqual(calls, [['systemctl', 'daemon-reload']])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('trusted proxy runtime requires an explicit browser origin before downtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-runtime-cors-'))
  try {
    const operations = createHostOperations({ run: async () => '' })
    await assert.rejects(() => operations.configureRuntime({
      appRoot: root,
      runtimeEnv: join(root, 'runtime.env'),
      dropinPath: join(root, 'systemd', 'release.conf'),
      apiKey: 'write-key',
      adminPassword: 'admin-password',
      trustProxy: 'true',
    }), /TOKEMBER_CORS_ORIGINS is required/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host browser smoke uses the configured public origin and exact CORS echo', async () => {
  const requests = []
  const operations = createHostOperations({
    fetchImpl: async (url, options) => {
      requests.push([url, options])
      return new Response('{}', {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': 'https://tokember.example' },
      })
    },
    sleep: async () => {},
  })
  await operations.verifyBrowserOrigin({
    corsOrigins: 'https://tokember.example, https://viewer.example',
    trustProxy: 'true',
    healthAttempts: 1,
    healthIntervalMs: 0,
  }, { releaseId: 'new' })
  assert.equal(requests[0][0], 'https://tokember.example/api/auth/session')
  assert.equal(requests[0][1].headers.Origin, 'https://tokember.example')
  assert.equal(requests[0][1].redirect, 'error')

  const rejected = createHostOperations({
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': 'https://other.example' },
    }),
    sleep: async () => {},
  })
  await assert.rejects(() => rejected.verifyBrowserOrigin({
    corsOrigins: 'https://tokember.example',
    trustProxy: 'true',
    healthAttempts: 1,
    healthIntervalMs: 0,
  }, { releaseId: 'new' }), /browser origin smoke failed for new/)
})

test('installed Sub2API units must disable successfully while missing units are skipped', async () => {
  const calls = []
  const operations = createHostOperations({
    run: async (_command, args) => {
      calls.push(args)
      if (args[0] === 'show') return args[1].startsWith('tokember-') ? 'loaded' : 'not-found'
      return ''
    },
  })
  await operations.disableSub2Api({})
  assert.deepEqual(calls.filter(args => args[0] !== 'show'), [
    ['disable', '--now', 'tokember-sub2api.timer'],
    ['stop', 'tokember-sub2api.service'],
  ])
})

test('first Linux publish bootstraps legacy server and stable web rollback link', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-legacy-'))
  try {
    const server = join(root, 'server')
    const web = join(root, 'site', 'index')
    await mkdir(join(server, 'dist'), { recursive: true })
    await mkdir(join(server, 'node_modules', 'hono'), { recursive: true })
    await mkdir(web, { recursive: true })
    await writeFile(join(server, 'dist', 'index.js'), 'old server', 'utf8')
    await writeFile(join(web, 'index.html'), 'old web', 'utf8')
    const operations = createHostOperations({ run: async () => '' })
    const previous = await operations.ensurePreviousRelease({
      appRoot: root,
      webTarget: web,
      service: 'tokember',
      legacyServerDir: server,
    })
    assert.equal(previous.legacy, true)
    assert.ok(previous.webPath)
    await assertSamePath(join(root, 'current'), previous.releasePath)
    assert.equal((await lstat(web)).isSymbolicLink(), true)
    await assertSamePath(web, previous.webPath)
    assert.equal((await readlink(web)).startsWith('.tokember-releases/'), true)
    assert.equal(await readFile(join(previous.releasePath, 'web/index.html'), 'utf8'), 'old web')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host switch uses a relative site-local web release link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-web-switch-'))
  try {
    const appRoot = join(root, 'app')
    const releasePath = join(appRoot, 'releases', 'new')
    const siteRoot = join(root, 'site')
    const webTarget = join(siteRoot, 'index')
    const webPath = join(siteRoot, '.tokember-releases', 'new')
    await mkdir(releasePath, { recursive: true })
    await mkdir(webPath, { recursive: true })
    const operations = createHostOperations()
    await operations.switchCurrent({ appRoot, webTarget }, {
      releaseId: 'new', releasePath, webPath,
    })
    await assertSamePath(join(appRoot, 'current'), releasePath)
    await assertSamePath(webTarget, webPath)
    assert.equal((await readlink(webTarget)).replaceAll('\\', '/'), '.tokember-releases/new')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Docker and optional private deploy share the root-locked release staging path', async () => {
  const [dockerfile, compose, workflow] = await Promise.all([
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
    readOptionalFile(new URL('../.github/workflows/deploy.yml', import.meta.url)),
  ])
  assert.match(dockerfile, /COPY package\.json package-lock\.json/)
  assert.match(dockerfile, /FROM node:22-bookworm AS build/)
  assert.match(dockerfile, /FROM node:22-bookworm-slim/)
  assert.doesNotMatch(dockerfile, /alpine/)
  assert.match(dockerfile, /RUN npm ci/)
  assert.match(dockerfile, /stage-release\.mjs/)
  assert.match(dockerfile, /healthcheck\.mjs/)
  assert.doesNotMatch(dockerfile, /npm install/)
  assert.match(compose, /health\/ready/)
  assert.match(dockerfile, /npm prune --omit=dev/)
  if (workflow) {
    assert.match(workflow, /npm run verify/)
    assert.match(workflow, /docker\/setup-qemu-action@v3/)
    assert.match(workflow, /docker\/setup-buildx-action@v3/)
    assert.match(workflow, /--platform linux\/arm64/)
    assert.match(workflow, /--target release-export/)
    assert.match(workflow, /docker build/)
    assert.match(workflow, /\.State\.Health\.Status/)
    assert.match(workflow, /healthcheck\.mjs[\s\S]+EXPECTED_RELEASE/)
    assert.match(workflow, /sha256sum -c deploy\.tar\.gz\.sha256/)
    assert.match(workflow, /publish-release\.mjs/)
    assert.doesNotMatch(workflow, /https?:\/\/[^\s]+\.site\b|\/opt\/1panel\//)
    const verifyIndex = workflow.indexOf('npm run verify')
    const dockerIndex = workflow.indexOf('docker build')
    const stageIndex = workflow.indexOf('--target release-export')
    assert.ok(verifyIndex < dockerIndex)
    assert.ok(dockerIndex < stageIndex)
  }
})

test('public CI is Linux-only and separate from production deploy', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const deploy = await readOptionalFile(new URL('../.github/workflows/deploy.yml', import.meta.url))

  assert.match(ci, /^name:\s*CI\s*$/m)
  assert.match(ci, /pull_request:/)
  assert.match(ci, /ubuntu-latest/)
  // Private-repo Actions minutes: win×2 / mac×10. Default CI stays Linux-only.
  assert.doesNotMatch(ci, /windows-latest/)
  assert.doesNotMatch(ci, /macos-latest/)
  assert.match(ci, /npm run typecheck/)
  assert.match(ci, /npm test/)
  assert.match(ci, /npm run build/)
  assert.match(ci, /npm run test:dist/)
  assert.match(ci, /browser-e2e:/)
  assert.match(ci, /playwright install --with-deps chromium/)
  assert.match(ci, /npm run test:e2e/)
  assert.match(ci, /scan-public-hygiene\.mjs/)
  assert.match(ci, /Validate public export manifest[\s\S]+--manifest-only/)
  assert.match(ci, /Verify exported public tree[\s\S]+github\.event_name != 'pull_request'/)
  assert.match(ci, /npm run public:verify -- --public-root \./)
  assert.match(ci, /--platform linux\/arm64/)
  assert.doesNotMatch(ci, /appleboy\/ssh-action/)
  assert.doesNotMatch(ci, /DEPLOY_HOST|DEPLOY_KEY|publish-release\.mjs/)

  if (deploy) {
    assert.match(deploy, /^name:\s*Deploy production\s*$/m)
    assert.doesNotMatch(deploy, /pull_request:/)
    assert.match(deploy, /cancel-in-progress:\s*true/)
  }
})

test('Windows collector installer supports adaptive upgrades and fixed rollback', async () => {
  const setup = await readFile(new URL('../collector/setup-collector.ps1', import.meta.url), 'utf8')
  assert.match(setup, /ValidateSet\('adaptive', 'fixed'\)/)
  assert.match(setup, /ValidateSet\('install', 'upgrade', 'uninstall', 'doctor', 'collect', 'dry-run'\)/)
  assert.match(setup, /\[string\]\$ScheduleMode = 'adaptive'/)
  assert.match(setup, /if \(\$ScheduleMode -eq 'adaptive'\) \{ 1 \} else \{ 30 \}/)
  assert.match(setup, /function Set-EnvSetting/)
  assert.match(setup, /TOKEMBER_SCHEDULE_MODE' -Value \$ScheduleMode/)
  assert.match(setup, /TOKEMBER_SCHEDULE_INTERVAL_MINUTES' -Value/)
  assert.match(setup, /UTF8Encoding\]::new\(\$false\)/)
  assert.match(setup, /\[int\]\$Matches\.major -eq 22/)
  assert.doesNotMatch(setup, /\[int\]\$Matches\.major -ge 22/)
  assert.match(setup, /%\*/)
  assert.match(setup, /-MultipleInstances IgnoreNew/)
  assert.match(setup, /-RepetitionInterval \(New-TimeSpan -Minutes \$scheduleIntervalMinutes\)/)
  assert.match(setup, /Register-ScheduledTask[\s\S]+-Force \| Out-Null/)
  assert.match(setup, /--force/)
  assert.match(setup, /\$collectorLogMaxBytes = 10 \* 1024 \* 1024/)
  assert.match(setup, /set "LOG_MAX_BYTES=\$collectorLogMaxBytes"/)
  assert.match(setup, /move \/Y "%LOG%" "%LOG%\.1"/)
  assert.ok(setup.indexOf('LOG_MAX_BYTES') < setup.indexOf('--- start ---'))
  assert.doesNotMatch(setup, /Start-ScheduledTask/)
  assert.match(setup, /function Invoke-Doctor/)
  assert.match(setup, /function Invoke-Uninstall/)
  assert.ok(
    setup.indexOf("& $registerTask 'tokember-collector'")
      < setup.indexOf('$legacyTask = Get-ScheduledTask'),
  )
})

test('cross-platform collector installer entry covers Unix launchd and systemd', async () => {
  const [entry, unix] = await Promise.all([
    readFile(new URL('../collector/install.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../collector/setup-collector.sh', import.meta.url), 'utf8'),
  ])
  assert.match(entry, /setup-collector\.ps1/)
  assert.match(entry, /setup-collector\.sh/)
  assert.match(entry, /doctor/)
  assert.match(entry, /diagnose/)
  assert.match(entry, /--output/)
  assert.match(entry, /uninstall/)
  assert.match(unix, /LaunchAgents/)
  assert.match(unix, /systemd --user/)
  assert.match(unix, /com\.tokember\.collector/)
  assert.match(unix, /UNIT_NAME="tokember-collector"/)
  assert.match(unix, /\$\{UNIT_NAME\}\.timer/)
  assert.match(unix, /major == 22/)
  assert.doesNotMatch(unix, /major >= 22/)
  assert.match(unix, /doctor\(\)/)
  assert.match(unix, /--purge/)
  assert.match(unix, /tokember\.example/)
})

test('collector package meta is deterministic and multi-platform', () => {
  const first = buildCollectorPackageMeta({
    version: '0.1.0',
    commit: COMMIT,
    builtAt: BUILT_AT,
  })
  const second = buildCollectorPackageMeta({
    version: '0.1.0',
    commit: COMMIT,
    builtAt: BUILT_AT,
  })
  assert.deepEqual(first, second)
  assert.equal(first.schema_version, 1)
  assert.equal(first.kind, 'collector')
  assert.deepEqual(first.platforms, ['windows', 'macos', 'linux'])
  assert.equal(first.node_engine, '>=22 <23')
  assert.equal(first.entry, 'install.mjs')
  assert.equal(first.install.diagnose, 'node install.mjs diagnose --output tokember-diagnostics.json')
})

test('stageCollectorRelease ships installers and dist, never env secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-collector-release-'))
  const workspace = join(root, 'workspace')
  const output = join(root, 'tokember-collector-pack')
  try {
    await writeFixtureFiles(workspace, {
      'collector/package.json': JSON.stringify({ name: '@tokember/collector', version: '0.1.0' }),
      'collector/dist/index.js': 'export {}\n',
      'collector/diagnostics.mjs': 'export {}\n',
      'collector/install.mjs': '#!/usr/bin/env node\n',
      'collector/setup-collector.ps1': '# ps1\n',
      'collector/setup-collector.sh': '#!/bin/sh\n',
      'collector/setup-hermes-collector.sh': '#!/bin/sh\n',
      'collector/collector.env': 'TOKEMBER_API_KEY=should-not-ship\n',
      'collector/collector.log': 'secret log\n',
    })
    const { meta } = await stageCollectorRelease({
      workspaceRoot: workspace,
      outputDir: output,
      commit: COMMIT,
      builtAt: BUILT_AT,
    })
    assert.equal(meta.version, '0.1.0')
    const files = (await collectFiles(output))
      .map(path => relative(output, path).replaceAll('\\', '/'))
      .sort()
    assert.ok(files.includes('dist/index.js'))
    assert.ok(files.includes('diagnostics.mjs'))
    assert.ok(files.includes('install.mjs'))
    assert.ok(files.includes('setup-collector.ps1'))
    assert.ok(files.includes('setup-collector.sh'))
    assert.ok(files.includes('package-meta.json'))
    assert.ok(files.includes('SHA256SUMS'))
    assert.ok(files.includes('README-COLLECTOR.txt'))
    assert.equal(files.includes('collector.env'), false)
    assert.equal(files.includes('collector.log'), false)
    await verifyChecksumManifest(output)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('image manifest requires dual-arch style platforms and optional digests', () => {
  const manifest = buildImageManifest({
    version: '0.1.0',
    commit: COMMIT,
    images: [
      { platform: 'linux/amd64', tag: 'ghcr.io/example/tokember:0.1.0' },
      {
        platform: 'linux/arm64',
        tag: 'ghcr.io/example/tokember:0.1.0',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
  })
  assert.equal(manifest.kind, 'server-image')
  assert.equal(manifest.release_id, '0.1.0-0123456789ab')
  assert.equal(manifest.images.length, 2)
  assert.throws(
    () => buildImageManifest({
      version: '0.1.0', commit: COMMIT, images: [{ platform: 'windows/amd64', tag: 'x' }],
    }),
    /platform/,
  )
})

test('public release workflow packages collector and stays off production deploy', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const deploy = await readOptionalFile(new URL('../.github/workflows/deploy.yml', import.meta.url))
  const gateIndex = release.indexOf('  platform-release-gate:')
  const collectorIndex = release.indexOf('  package-collector:')
  const imagesIndex = release.indexOf('  package-images:')
  const publishIndex = release.indexOf('  publish:')
  const topLevel = release.slice(0, gateIndex)
  const gateJob = release.slice(gateIndex, collectorIndex)
  const collectorJob = release.slice(collectorIndex, imagesIndex)
  const imagesJob = release.slice(imagesIndex, publishIndex)
  const publishJob = release.slice(publishIndex)
  assert.match(release, /^name:\s*Release\s*$/m)
  assert.match(release, /schedule:\s*\n\s*- cron:/)
  assert.match(topLevel, /permissions:\s*\n\s+contents: read/)
  assert.doesNotMatch(topLevel, /contents: write|packages: write/)
  assert.match(gateJob, /github\.repository == 'GoldenZqqq\/Tokember'/)
  assert.match(gateJob, /runs-on: \$\{\{ matrix\.os \}\}/)
  assert.match(gateJob, /os: \[ubuntu-latest, windows-latest, macos-latest\]/)
  assert.match(gateJob, /node-version: '22'/)
  assert.match(gateJob, /python-version: '3\.12'/)
  assert.match(gateJob, /run: npm ci/)
  assert.match(gateJob, /run: npm run verify/)
  assert.match(gateJob, /runner\.os == 'Windows'[\s\S]+run: npm run test:e2e/)
  assert.doesNotMatch(gateJob, /test:e2e[^\n]*--workers/)
  assert.match(collectorJob, /needs: platform-release-gate/)
  assert.match(imagesJob, /needs: platform-release-gate/)
  assert.match(collectorJob, /startsWith\(github\.ref, 'refs\/tags\/v'\)[\s\S]+workflow_dispatch/)
  assert.match(imagesJob, /startsWith\(github\.ref, 'refs\/tags\/v'\)[\s\S]+workflow_dispatch/)
  assert.match(publishJob, /needs: \[package-collector, package-images\]/)
  assert.match(publishJob, /github\.repository == 'GoldenZqqq\/Tokember'/)
  assert.match(release, /package-collector-release\.mjs/)
  assert.match(release, /package-image-manifest\.mjs/)
  assert.doesNotMatch(release, /steps\.manifest\.outputs/)
  assert.match(release, /linux\/amd64,linux\/arm64|linux\/amd64/)
  assert.match(release, /linux\/arm64/)
  assert.match(release, /softprops\/action-gh-release/)
  assert.match(release, /tags:\s*\n\s*-\s*'v\*'/m)
  assert.doesNotMatch(release, /appleboy\/ssh-action/)
  assert.doesNotMatch(release, /DEPLOY_HOST|publish-release\.mjs/)
  if (deploy) assert.match(deploy, /Deploy production/)
})
