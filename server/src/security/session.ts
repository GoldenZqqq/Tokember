import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthRole } from '@tokember/contracts/security'
import type { DB } from '../db.js'
import {
  configuredAdminPassword,
  configuredAdminPreviousSecret,
  configuredAdminSecret,
  configuredCookieSameSite,
  configuredCookieSecure,
  configuredViewerPassword,
  configuredViewerPreviousSecret,
  configuredViewerSecret,
  trustProxy,
} from '../config.js'

const SESSION_SECONDS = 7 * 24 * 60 * 60
const COOKIE_NAMES: Record<AuthRole, string> = {
  admin: 'tokember_admin', viewer: 'tokember_viewer',
}

interface SessionRow {
  role: AuthRole
  expires_at: string
  revoked_at: string | null
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function developmentAdminPassword(env: NodeJS.ProcessEnv): string {
  // Generic local-only fallback. Production must set TOKEMBER_ADMIN_PASSWORD.
  return configuredAdminPassword(env) || 'development'
}

function rolePassword(role: AuthRole, env: NodeJS.ProcessEnv): string {
  return role === 'admin' ? developmentAdminPassword(env) : configuredViewerPassword(env)
}

function roleSecrets(role: AuthRole, env: NodeJS.ProcessEnv): string[] {
  const password = rolePassword(role, env)
  const current = role === 'admin'
    ? configuredAdminSecret(env) || `tokember:${password}:admin-session:v2`
    : configuredViewerSecret(env) || `tokember:${password}:viewer-session:v2`
  const previous = role === 'admin'
    ? configuredAdminPreviousSecret(env) : configuredViewerPreviousSecret(env)
  return previous && previous !== current ? [current, previous] : [current]
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function validSignature(token: string, role: AuthRole, env: NodeJS.ProcessEnv): boolean {
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1' || parts[1] !== role) return false
  const payload = parts.slice(0, 3).join('.')
  return roleSecrets(role, env).some(secret => safeEqual(parts[3], sign(payload, secret)))
}

function secureRequest(c: Context, env: NodeJS.ProcessEnv): boolean {
  const configured = configuredCookieSecure(env)
  if (typeof configured === 'boolean') return configured
  if (new URL(c.req.url).protocol === 'https:') return true
  return trustProxy(env) && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
}

function cookieOptions(c: Context, env: NodeJS.ProcessEnv) {
  return {
    httpOnly: true, maxAge: SESSION_SECONDS, path: '/',
    sameSite: configuredCookieSameSite(env), secure: secureRequest(c, env),
  } as const
}

export class SessionService {
  constructor(
    private readonly db: DB,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  viewerRequired(): boolean {
    return Boolean(configuredViewerPassword(this.env))
  }

  verifyPassword(role: AuthRole, value: unknown): boolean {
    const expected = rolePassword(role, this.env)
    return Boolean(expected) && typeof value === 'string' && safeEqual(value, expected)
  }

  create(role: AuthRole, c: Context, now = new Date()): void {
    const random = randomBytes(32).toString('base64url')
    const payload = `v1.${role}.${random}`
    const token = `${payload}.${sign(payload, roleSecrets(role, this.env)[0])}`
    const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString()
    this.db.prepare(`
      INSERT INTO auth_sessions (token_hash, role, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hash(token), role, expiresAt, now.toISOString())
    this.prune(now)
    setCookie(c, COOKIE_NAMES[role], token, cookieOptions(c, this.env))
  }

  authenticated(role: AuthRole, c: Context, now = new Date()): boolean {
    const token = getCookie(c, COOKIE_NAMES[role])
    if (!token || !validSignature(token, role, this.env)) return false
    const row = this.db.prepare(`
      SELECT role, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?
    `).get(hash(token)) as SessionRow | undefined
    return row?.role === role && row.revoked_at == null && row.expires_at > now.toISOString()
  }

  canView(c: Context, now = new Date()): boolean {
    return !this.viewerRequired()
      || this.authenticated('viewer', c, now)
      || this.authenticated('admin', c, now)
  }

  logout(role: AuthRole, c: Context, now = new Date()): void {
    const token = getCookie(c, COOKIE_NAMES[role])
    if (token) this.db.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `).run(now.toISOString(), hash(token))
    deleteCookie(c, COOKIE_NAMES[role], {
      path: '/', secure: secureRequest(c, this.env),
      sameSite: configuredCookieSameSite(this.env),
    })
  }

  requireAdmin(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.authenticated('admin', c)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    }
  }

  requireViewer(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.canView(c)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    }
  }

  private prune(now: Date): void {
    this.db.prepare(`
      DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL
    `).run(now.toISOString())
  }
}
