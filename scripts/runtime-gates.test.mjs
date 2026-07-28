import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertSupportedRuntime,
  verifyNativeRuntime,
} from './verify-runtime.mjs'
import { assertInstallerPlan } from './verify-installer-platform.mjs'

const NODE_22 = {
  nodeVersion: 'v22.18.0',
  moduleAbi: '127',
  platform: 'win32',
  architecture: 'x64',
}

test('runtime gate accepts Node 22 and rejects every other major with fixed diagnostics', () => {
  assert.deepEqual(assertSupportedRuntime(NODE_22), NODE_22)
  for (const [nodeVersion, moduleAbi] of [
    ['v20.19.0', '115'],
    ['v23.11.0', '131'],
    ['v24.18.0', '137'],
  ]) {
    assert.throws(
      () => assertSupportedRuntime({ ...NODE_22, nodeVersion, moduleAbi }),
      /supports Node 22\.x; got Node v\d+\.\d+\.\d+ \(ABI \d+, win32\/x64\).*Select Node 22 and run npm ci/,
    )
  }
})

test('runtime package manifests and root lock certify only Node 22', async () => {
  const paths = ['../package.json', '../server/package.json', '../collector/package.json']
  const manifests = await Promise.all(paths.map(async path => (
    JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
  )))
  for (const manifest of manifests) assert.equal(manifest.engines.node, '>=22 <23')

  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const path of ['', 'server', 'collector']) {
    assert.equal(lock.packages[path].engines.node, '>=22 <23')
  }
})

test('native runtime gate queries better-sqlite3 and redacts loader failures', () => {
  const calls = []
  class Database {
    constructor(path) { calls.push(['open', path]) }
    prepare(sql) {
      calls.push(['prepare', sql])
      return { get: () => ({ ok: 1 }) }
    }
    close() { calls.push(['close']) }
  }
  assert.deepEqual(
    verifyNativeRuntime({ identity: NODE_22, loadDatabase: () => Database }),
    NODE_22,
  )
  assert.deepEqual(calls, [
    ['open', ':memory:'],
    ['prepare', 'SELECT 1 AS ok'],
    ['close'],
  ])

  assert.throws(
    () => verifyNativeRuntime({
      identity: NODE_22,
      loadDatabase: () => { throw new Error('C:\\Users\\secret\\better_sqlite3.node') },
    }),
    error => {
      assert.match(error.message, /better-sqlite3 is not loadable/)
      assert.match(error.message, /Node v22\.18\.0 \(ABI 127, win32\/x64\)/)
      assert.match(error.message, /Select Node 22 and run npm ci/)
      assert.doesNotMatch(error.message, /secret|better_sqlite3\.node/)
      return true
    },
  )
})

test('installer gate requires both schedule modes and the real platform scheduler marker', () => {
  const fixtures = [
    ['win32', 'register task tokember-collector'],
    ['darwin', 'Library/LaunchAgents/com.tokember.collector.plist'],
    ['linux', '.config/systemd/user/tokember-collector.timer'],
  ]
  for (const [platform, marker] of fixtures) {
    assertInstallerPlan({
      platform,
      schedule: 'adaptive',
      output: `DRY-RUN install schedule=adaptive interval=1m\nwould ${marker}`,
    })
    assertInstallerPlan({
      platform,
      schedule: 'fixed',
      output: `DRY-RUN install schedule=fixed interval=30m\nwould ${marker}`,
    })
  }
  assert.throws(
    () => assertInstallerPlan({
      platform: 'darwin', schedule: 'adaptive', output: 'DRY-RUN install schedule=adaptive interval=1m',
    }),
    /missing launchd scheduler marker/,
  )
  assert.throws(
    () => assertInstallerPlan({ platform: 'freebsd', schedule: 'fixed', output: '' }),
    /unsupported release-gate platform/,
  )
})
