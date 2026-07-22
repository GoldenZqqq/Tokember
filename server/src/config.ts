type RuntimeEnv = NodeJS.ProcessEnv

function firstConfigured(env: RuntimeEnv, keys: readonly string[]): string {
  for (const key of keys) {
    const value = (env[key] || '').trim()
    if (value) return value
  }
  return ''
}

export function configuredApiKey(env: RuntimeEnv = process.env): string | null {
  return firstConfigured(env, ['TOKEMBER_API_KEY', 'AI_BURN_API_KEY', 'API_KEY']) || null
}

export function configuredAdminPassword(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_ADMIN_PASSWORD', 'AI_BURN_ADMIN_PASSWORD'])
}

export function configuredAdminSecret(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_ADMIN_SECRET', 'AI_BURN_ADMIN_SECRET'])
}

export function configuredAdminPreviousSecret(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_ADMIN_SECRET_PREVIOUS'])
}

export function configuredViewerPassword(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_VIEWER_PASSWORD'])
}

export function configuredViewerSecret(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_VIEWER_SECRET'])
}

export function configuredViewerPreviousSecret(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_VIEWER_SECRET_PREVIOUS'])
}

export function configuredAuthAuditSecret(env: RuntimeEnv = process.env): string {
  return firstConfigured(env, ['TOKEMBER_AUTH_AUDIT_SECRET'])
}

export function trustProxy(env: RuntimeEnv = process.env): boolean {
  return firstConfigured(env, ['TOKEMBER_TRUST_PROXY']).toLowerCase() === 'true'
}

export function allowLegacyApiKey(env: RuntimeEnv = process.env): boolean {
  return firstConfigured(env, ['TOKEMBER_ALLOW_LEGACY_API_KEY']).toLowerCase() !== 'false'
}

export type CookieSameSite = 'Lax' | 'Strict' | 'None'

export function configuredCookieSameSite(env: RuntimeEnv = process.env): CookieSameSite {
  const value = firstConfigured(env, ['TOKEMBER_COOKIE_SAME_SITE']).toLowerCase()
  if (value === 'strict') return 'Strict'
  if (value === 'none') return 'None'
  return 'Lax'
}

export function configuredCookieSecure(env: RuntimeEnv = process.env): 'auto' | boolean {
  const value = firstConfigured(env, ['TOKEMBER_COOKIE_SECURE']).toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return 'auto'
}

export function configuredCorsOrigins(env: RuntimeEnv = process.env): string[] {
  const raw = firstConfigured(env, ['TOKEMBER_CORS_ORIGINS'])
  return raw ? raw.split(',').map(value => value.trim()).filter(Boolean) : []
}
