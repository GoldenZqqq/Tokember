import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BuildInfo } from '@tokember/contracts/release'
import type { DB } from './db.js'
import { initDB } from './db.js'
import { decodeBuildInfo, isReleaseBuild, loadBuildInfo } from './build-info.js'
import { getLiveness, getReadiness } from './health.js'
import { apiRoutes } from './routes.js'

const BUILD: BuildInfo = {
  schema_version: 2,
  release_id: '0.1.0-0123456789ab',
  version: '0.1.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  built_at: '2026-07-17T00:00:00.000Z',
  node_version: '22.17.0',
  architecture: 'arm64',
  lockfile_sha256: 'a'.repeat(64),
  runtime_dependencies: { 'node_modules/hono': '4.12.29' },
}

const PROD_ENV = {
  NODE_ENV: 'production',
  TOKEMBER_API_KEY: 'write-key',
  TOKEMBER_ADMIN_PASSWORD: 'admin-password',
} as NodeJS.ProcessEnv

test('build metadata decoder accepts release identity and rejects unsafe values', () => {
  assert.deepEqual(decodeBuildInfo(BUILD), BUILD)
  assert.equal(isReleaseBuild(BUILD), true)
  assert.equal(decodeBuildInfo({ ...BUILD, schema_version: 1 }), null)
  assert.equal(decodeBuildInfo({ ...BUILD, release_id: '../escape' }), null)
  assert.equal(decodeBuildInfo({ ...BUILD, commit: 'unknown' }), null)
  assert.equal(decodeBuildInfo({ ...BUILD, architecture: undefined }), null)
  assert.equal(decodeBuildInfo({ ...BUILD, architecture: '../x64' }), null)
  assert.equal(decodeBuildInfo({ ...BUILD, lockfile_sha256: 'secret-write-key' }), null)
})

test('build identity loads from the release metadata path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-build-info-'))
  try {
    const path = join(directory, 'release.json')
    await writeFile(path, JSON.stringify(BUILD), 'utf8')
    assert.deepEqual(loadBuildInfo({ TOKEMBER_BUILD_METADATA: path }), BUILD)
    await writeFile(path, JSON.stringify({ ...BUILD, commit: 'invalid' }), 'utf8')
    assert.equal(loadBuildInfo({ TOKEMBER_BUILD_METADATA: path }).release_id, 'development')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('liveness exposes process identity and protocol window without touching the database', () => {
  const result = getLiveness(BUILD, '2026-07-17T01:00:00.000Z')
  assert.deepEqual(result, {
    status: 'ok',
    release_id: BUILD.release_id,
    commit: BUILD.commit,
    started_at: '2026-07-17T01:00:00.000Z',
    protocol: {
      protocol_version: 1,
      min_protocol_version: 1,
      max_protocol_version: 1,
    },
  })
})

test('readiness requires database schema config and release metadata in production', () => {
  const db = initDB(':memory:')
  const ready = getReadiness(db, BUILD, {
    env: PROD_ENV, runtimeVersion: '22.18.0', runtimeArchitecture: 'arm64',
  })
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.checks, {
    database: true, schema: true, config: true, metadata: true, runtime: true,
  })

  const missingConfig = getReadiness(db, BUILD, {
    env: { NODE_ENV: 'production' }, runtimeVersion: '22.18.0',
    runtimeArchitecture: 'arm64',
  })
  assert.equal(missingConfig.status, 'not_ready')
  assert.equal(missingConfig.checks.config, false)

  const localMetadata = { ...BUILD, release_id: 'development', commit: 'unknown' }
  const missingMetadata = getReadiness(db, localMetadata, {
    env: PROD_ENV, runtimeVersion: '22.18.0', runtimeArchitecture: 'arm64',
  })
  assert.equal(missingMetadata.checks.metadata, false)
  const wrongRuntime = getReadiness(db, BUILD, {
    env: PROD_ENV, runtimeVersion: '20.19.0',
  })
  assert.equal(wrongRuntime.checks.runtime, false)
  const wrongArchitecture = getReadiness(db, BUILD, {
    env: PROD_ENV, runtimeVersion: '22.18.0', runtimeArchitecture: 'x64',
  })
  assert.equal(wrongArchitecture.checks.runtime, false)

  const deviceOnlyEnv = {
    NODE_ENV: 'production', TOKEMBER_ADMIN_PASSWORD: 'admin-password',
    TOKEMBER_ALLOW_LEGACY_API_KEY: 'false',
  } as NodeJS.ProcessEnv
  assert.equal(getReadiness(db, BUILD, {
    env: deviceOnlyEnv, runtimeVersion: '22.18.0', runtimeArchitecture: 'arm64',
  }).checks.config, false)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  db.prepare(`
    INSERT INTO device_credentials
      (token_id, device_id, label, secret_hash, created_at)
    VALUES ('abcdefghijkl', 'd1', 'Primary', ?, '2026-07-18T00:00:00.000Z')
  `).run('a'.repeat(64))
  assert.equal(getReadiness(db, BUILD, {
    env: deviceOnlyEnv, runtimeVersion: '22.18.0', runtimeArchitecture: 'arm64',
  }).checks.config, true)
  db.close()
})

test('readiness returns named failures without leaking config values', () => {
  const broken = {
    prepare() { throw new Error('db secret detail') },
  } as unknown as DB
  const result = getReadiness(broken, BUILD, { env: PROD_ENV })
  assert.equal(result.status, 'not_ready')
  assert.equal(result.checks.database, false)
  assert.doesNotMatch(JSON.stringify(result), /write-key|admin-password|db secret detail/)
})

test('public health routes distinguish live from ready status', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db, undefined, {
    buildInfo: BUILD,
    env: { NODE_ENV: 'production' },
  })
  const live = await app.request('/health/live')
  const ready = await app.request('/health/ready')
  assert.equal(live.status, 200)
  assert.equal(ready.status, 503)
  const liveBody = await live.json() as {
    protocol: { protocol_version: number; min_protocol_version: number; max_protocol_version: number }
  }
  assert.deepEqual(liveBody.protocol, {
    protocol_version: 1, min_protocol_version: 1, max_protocol_version: 1,
  })
  const readyBody = await ready.json() as {
    checks: { config: boolean }
    protocol: { protocol_version: number }
  }
  assert.equal(readyBody.checks.config, false)
  assert.equal(readyBody.protocol.protocol_version, 1)
  db.close()
})
