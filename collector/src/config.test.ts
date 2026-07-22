import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCollectorTarget, collectorConfig, configuredSourceMode } from './config.js'

test('Tokember collector variables take precedence', () => {
  const config = collectorConfig({
    TOKEMBER_SERVER: 'https://tokember.example',
    AI_BURN_SERVER: 'https://legacy.example',
    TOKEMBER_DEVICE_TOKEN: 'device-token',
    TOKEMBER_API_KEY: 'tokember-key',
    AI_BURN_API_KEY: 'legacy-key',
    TOKEMBER_DEVICE_ID: 'tokember-device',
    TOKEMBER_DEVICE_NAME: 'Tokember Device',
    TOKEMBER_ATTRIBUTION_ENABLED: 'true',
    TOKEMBER_ATTRIBUTION_SECRET_FILE: 'C:\\secure\\attribution-secret',
  })

  assert.equal(config.serverUrl, 'https://tokember.example')
  assert.equal(config.credential, 'device-token')
  assert.equal(config.deviceId, 'tokember-device')
  assert.equal(config.deviceName, 'Tokember Device')
  assert.equal(config.machine.hostname.length > 0, true)
  assert.equal(['windows', 'macos', 'linux', 'other'].includes(config.machine.platform), true)
  assert.equal(config.machine.architecture.length > 0, true)
  assert.equal(config.scheduleIntervalMinutes, 30)
  assert.equal(config.collectorVersion, '0.1.0')
  assert.equal(config.attributionEnabled, true)
  assert.equal(config.attributionSecretFile, 'C:\\secure\\attribution-secret')
})

test('collector schedule metadata is explicit and bounded', () => {
  assert.equal(collectorConfig({
    TOKEMBER_SCHEDULE_INTERVAL_MINUTES: '60',
  }).scheduleIntervalMinutes, 60)
  assert.throws(() => collectorConfig({
    TOKEMBER_SCHEDULE_INTERVAL_MINUTES: '0',
  }), /must be an integer/)
  assert.throws(() => collectorConfig({
    TOKEMBER_SCHEDULE_INTERVAL_MINUTES: '1.5',
  }), /must be an integer/)
})

test('adaptive schedule mode is opt-in and rejects unknown values', () => {
  assert.equal(collectorConfig({}).scheduleMode, 'fixed')
  assert.equal(collectorConfig({ TOKEMBER_SCHEDULE_MODE: 'adaptive' }).scheduleMode, 'adaptive')
  assert.throws(() => collectorConfig({ TOKEMBER_SCHEDULE_MODE: 'fast' }), /fixed or adaptive/)
})

test('legacy collector variables remain migration fallbacks', () => {
  const config = collectorConfig({
    AI_BURN_SERVER: 'https://legacy.example',
    AI_BURN_API_KEY: 'legacy-key',
    AI_BURN_DEVICE_ID: 'legacy-device',
    AI_BURN_DEVICE_NAME: 'Legacy Device',
  })

  assert.equal(config.serverUrl, 'https://legacy.example')
  assert.equal(config.credential, 'legacy-key')
  assert.equal(config.deviceId, 'legacy-device')
  assert.equal(config.deviceName, 'Legacy Device')
})

test('source selection accepts canonical and legacy controls', () => {
  assert.equal(configuredSourceMode({ TOKEMBER_CLAUDE_CODEX_SOURCE: 'native' }), 'native')
  assert.equal(configuredSourceMode({ AI_BURN_CLAUDE_CODEX_SOURCE: 'cc-switch' }), 'cc-switch')
  assert.equal(configuredSourceMode({ TOKEMBER_ENABLE_CCSWITCH: '1' }), 'cc-switch')
  assert.equal(configuredSourceMode({ AI_BURN_ENABLE_CCSWITCH: '0' }), 'native')
})

test('attribution is opt-in and validates boolean configuration', () => {
  assert.equal(collectorConfig({}).attributionEnabled, false)
  assert.equal(collectorConfig({ AI_BURN_ATTRIBUTION_ENABLED: '1' }).attributionEnabled, true)
  assert.throws(() => collectorConfig({ TOKEMBER_ATTRIBUTION_ENABLED: 'yes' }), /must be true or false/)
})

test('collector fails closed without a configured server or credential', () => {
  const bare = collectorConfig({})
  assert.equal(bare.serverUrl, '')
  assert.equal(bare.credential, '')
  assert.throws(() => assertCollectorTarget(bare), /TOKEMBER_SERVER/)
  assert.throws(
    () => assertCollectorTarget({ serverUrl: 'https://tokember.example', credential: '' }),
    /TOKEMBER_DEVICE_TOKEN/,
  )
  assert.doesNotThrow(() => assertCollectorTarget({
    serverUrl: 'https://tokember.example',
    credential: 'device-token',
  }))
})
