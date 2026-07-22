import type { DB } from './db.js'
import {
  allowLegacyApiKey,
  configuredAdminPassword,
  configuredApiKey,
  configuredCookieSameSite,
  configuredCookieSecure,
} from './config.js'

function activeCredentialCount(db: DB): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM device_credentials WHERE revoked_at IS NULL
  `).get() as { count: number }).count
}

export function runtimeAuthConfigured(
  db: DB,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!configuredAdminPassword(env)) return false
  const collectorConfigured = allowLegacyApiKey(env)
    ? Boolean(configuredApiKey(env))
    : activeCredentialCount(db) > 0
  const cookieConfigured = configuredCookieSameSite(env) !== 'None'
    || configuredCookieSecure(env) !== false
  return collectorConfigured && cookieConfigured
}

export function assertRuntimeAuthConfig(
  db: DB,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') {
    if (!configuredAdminPassword(env)) {
      console.warn('[tokember] TOKEMBER_ADMIN_PASSWORD is not set; using development default password')
    }
    if (allowLegacyApiKey(env) && !configuredApiKey(env)) {
      console.warn('[tokember] collector legacy API key is not set; development writes are open')
    }
    return
  }
  if (!runtimeAuthConfigured(db, env)) {
    console.error('[tokember] production authentication configuration is incomplete; refusing to start')
    process.exit(1)
  }
}
