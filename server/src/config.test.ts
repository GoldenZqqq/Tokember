import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  allowLegacyApiKey,
  configuredAdminPassword,
  configuredAdminSecret,
  configuredCookieSameSite,
  configuredCookieSecure,
  configuredCorsOrigins,
  configuredApiKey,
  configuredViewerPassword,
  trustProxy,
} from './config.js'
import { resolveDbPath } from './db.js'

test('Tokember environment variables take precedence over legacy aliases', () => {
  const env = {
    TOKEMBER_API_KEY: 'tokember-key',
    AI_BURN_API_KEY: 'legacy-key',
    TOKEMBER_ADMIN_PASSWORD: 'tokember-password',
    AI_BURN_ADMIN_PASSWORD: 'legacy-password',
    TOKEMBER_ADMIN_SECRET: 'tokember-secret',
    AI_BURN_ADMIN_SECRET: 'legacy-secret',
  }

  assert.equal(configuredApiKey(env), 'tokember-key')
  assert.equal(configuredAdminPassword(env), 'tokember-password')
  assert.equal(configuredAdminSecret(env), 'tokember-secret')
})

test('legacy environment variables remain valid migration fallbacks', () => {
  const env = {
    AI_BURN_API_KEY: 'legacy-key',
    AI_BURN_ADMIN_PASSWORD: 'legacy-password',
    AI_BURN_ADMIN_SECRET: 'legacy-secret',
  }

  assert.equal(configuredApiKey(env), 'legacy-key')
  assert.equal(configuredAdminPassword(env), 'legacy-password')
  assert.equal(configuredAdminSecret(env), 'legacy-secret')
})

test('security options are explicit and compatibility-safe by default', () => {
  assert.equal(configuredViewerPassword({}), '')
  assert.equal(allowLegacyApiKey({}), true)
  assert.equal(trustProxy({}), false)
  assert.equal(configuredCookieSameSite({}), 'Lax')
  assert.equal(configuredCookieSecure({}), 'auto')
  assert.deepEqual(configuredCorsOrigins({}), [])

  const env = {
    TOKEMBER_VIEWER_PASSWORD: 'viewer-password',
    TOKEMBER_ALLOW_LEGACY_API_KEY: 'false',
    TOKEMBER_TRUST_PROXY: 'true',
    TOKEMBER_COOKIE_SAME_SITE: 'none',
    TOKEMBER_COOKIE_SECURE: 'true',
    TOKEMBER_CORS_ORIGINS: 'https://one.example, https://two.example:8443',
  }
  assert.equal(configuredViewerPassword(env), 'viewer-password')
  assert.equal(allowLegacyApiKey(env), false)
  assert.equal(trustProxy(env), true)
  assert.equal(configuredCookieSameSite(env), 'None')
  assert.equal(configuredCookieSecure(env), true)
  assert.deepEqual(configuredCorsOrigins(env), [
    'https://one.example', 'https://two.example:8443',
  ])
})

test('database path prefers Tokember and detects an existing legacy database', () => {
  const emptyDirectory = mkdtempSync(join(tmpdir(), 'tokember-empty-'))
  assert.equal(resolveDbPath(undefined, emptyDirectory), join(emptyDirectory, 'tokember.db'))

  const legacyDirectory = mkdtempSync(join(tmpdir(), 'tokember-legacy-'))
  const legacyPath = join(legacyDirectory, 'ai-burn.db')
  writeFileSync(legacyPath, '')
  assert.equal(resolveDbPath(undefined, legacyDirectory), legacyPath)

  const canonicalPath = join(legacyDirectory, 'tokember.db')
  assert.equal(resolveDbPath(canonicalPath), legacyPath)
  writeFileSync(canonicalPath, '')
  assert.equal(resolveDbPath(undefined, legacyDirectory), canonicalPath)
  assert.equal(resolveDbPath(canonicalPath), canonicalPath)
})
