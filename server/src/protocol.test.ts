import assert from 'node:assert/strict'
import test from 'node:test'
import { initDB } from './db.js'
import {
  getProtocolWindow,
  isProtocolCompatible,
  parseClientProtocolVersion,
  protocolIncompatibleBody,
  SERVER_MAX_PROTOCOL_VERSION,
  SERVER_MIN_PROTOCOL_VERSION,
  SERVER_PROTOCOL_VERSION,
} from './protocol.js'
import { apiRoutes } from './routes.js'

test('protocol window is day-0 v1 and pins min/max', () => {
  assert.equal(SERVER_PROTOCOL_VERSION, 1)
  assert.equal(SERVER_MIN_PROTOCOL_VERSION, 1)
  assert.equal(SERVER_MAX_PROTOCOL_VERSION, 1)
  assert.deepEqual(getProtocolWindow(), {
    protocol_version: 1,
    min_protocol_version: 1,
    max_protocol_version: 1,
  })
})

test('parseClientProtocolVersion treats omit as v1 and rejects junk', () => {
  assert.equal(parseClientProtocolVersion(undefined), 1)
  assert.equal(parseClientProtocolVersion(null), 1)
  assert.equal(parseClientProtocolVersion(1), 1)
  assert.equal(parseClientProtocolVersion('2'), 2)
  assert.equal(parseClientProtocolVersion(0), null)
  assert.equal(parseClientProtocolVersion(1.5), null)
  assert.equal(parseClientProtocolVersion('nope'), null)
  assert.equal(parseClientProtocolVersion({}), null)
})

test('protocol compatibility rejects outside window', () => {
  assert.equal(isProtocolCompatible(1), true)
  assert.equal(isProtocolCompatible(2), false)
  assert.equal(isProtocolCompatible(null), false)
  const body = protocolIncompatibleBody(99)
  assert.equal(body.error, 'protocol_incompatible')
  assert.equal(body.client_protocol_version, 99)
  assert.equal(body.min_protocol_version, 1)
  assert.equal(body.max_protocol_version, 1)
  assert.match(body.upgrade_hint, /data-lifecycle/)
  assert.doesNotMatch(body.upgrade_hint, /password|token|secret|\.env/i)
})

test('POST /devices accepts omitted protocol as v1 and rejects future versions', async () => {
  const db = initDB(':memory:')
  // Isolate from host TOKEMBER_*/AI_BURN_* so open-dev writes stay available.
  const app = apiRoutes(db, undefined, { env: {} as NodeJS.ProcessEnv })
  const machine = {
    platform: 'linux', architecture: 'x64', hostname: 'host-1',
  }

  const legacy = await app.request('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'd1', name: 'Device', native_sources: ['claude'], ...machine,
    }),
  })
  assert.equal(legacy.status, 200)
  const legacyBody = await legacy.json() as { ok: boolean; protocol_version: number }
  assert.equal(legacyBody.ok, true)
  assert.equal(legacyBody.protocol_version, 1)

  const explicit = await app.request('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'd2', name: 'Device 2', native_sources: ['claude'],
      protocol_version: 1, ...machine,
    }),
  })
  assert.equal(explicit.status, 200)

  const future = await app.request('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'd3', name: 'Device 3', native_sources: ['claude'],
      protocol_version: 99, ...machine,
    }),
  })
  assert.equal(future.status, 426)
  const futureBody = await future.json() as {
    error: string
    client_protocol_version: number
    upgrade_hint: string
  }
  assert.equal(futureBody.error, 'protocol_incompatible')
  assert.equal(futureBody.client_protocol_version, 99)
  assert.match(futureBody.upgrade_hint, /Upgrade/)

  const invalid = await app.request('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'd4', name: 'Device 4', native_sources: ['claude'],
      protocol_version: 'broken', ...machine,
    }),
  })
  assert.equal(invalid.status, 426)
  db.close()
})
