import { createHmac } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import type { AuthRole } from '@tokember/contracts/security'
import type { DB } from '../db.js'
import {
  configuredAdminPassword,
  configuredAdminSecret,
  configuredAuthAuditSecret,
  trustProxy,
} from '../config.js'
import type { SessionService } from './session.js'

const WINDOW_MS = 10 * 60 * 1000
const MAX_FAILURES = 5
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function sourceAddress(c: Context, env: NodeJS.ProcessEnv): string {
  if (trustProxy(env)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
    const real = c.req.header('x-real-ip')?.trim()
    if (real) return real
  }
  try {
    return getConnInfo(c).remote.address ?? 'direct'
  } catch {
    return 'direct'
  }
}

function auditSecret(env: NodeJS.ProcessEnv): string {
  return configuredAuthAuditSecret(env)
    || configuredAdminSecret(env)
    || `tokember:${configuredAdminPassword(env) || 'development'}:auth-audit`
}

function sourceHash(c: Context, env: NodeJS.ProcessEnv): string {
  return createHmac('sha256', auditSecret(env))
    .update(sourceAddress(c, env)).digest('hex')
}

interface FailureRow {
  created_at: string
}

export class LoginService {
  constructor(
    private readonly db: DB,
    private readonly sessions: SessionService,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async login(role: AuthRole, c: Context, now = new Date()): Promise<Response> {
    const source = sourceHash(c, this.env)
    const retryAfter = this.retryAfter(role, source, now)
    if (retryAfter > 0) {
      this.record(role, source, 'rate_limited', now)
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: 'too_many_attempts' }, 429)
    }
    const body = await c.req.json().catch(() => ({})) as { password?: unknown }
    if (!this.sessions.verifyPassword(role, body.password)) {
      this.record(role, source, 'failure', now)
      return c.json({ error: 'invalid_credentials' }, 401)
    }
    this.sessions.create(role, c, now)
    this.record(role, source, 'success', now)
    return role === 'viewer'
      ? c.json({ required: true, authenticated: true })
      : c.json({ authenticated: true })
  }

  private retryAfter(role: AuthRole, source: string, now: Date): number {
    const since = new Date(now.getTime() - WINDOW_MS).toISOString()
    const rows = this.db.prepare(`
      SELECT created_at FROM auth_login_events
      WHERE role = ? AND source_hash = ? AND outcome = 'failure' AND created_at > ?
      ORDER BY created_at ASC LIMIT ?
    `).all(role, source, since, MAX_FAILURES) as FailureRow[]
    if (rows.length < MAX_FAILURES) return 0
    const release = new Date(rows[0].created_at).getTime() + WINDOW_MS
    return Math.max(1, Math.ceil((release - now.getTime()) / 1000))
  }

  private record(
    role: AuthRole,
    source: string,
    outcome: 'success' | 'failure' | 'rate_limited',
    now: Date,
  ): void {
    this.db.prepare(`
      INSERT INTO auth_login_events (role, source_hash, outcome, created_at)
      VALUES (?, ?, ?, ?)
    `).run(role, source, outcome, now.toISOString())
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString()
    this.db.prepare('DELETE FROM auth_login_events WHERE created_at < ?').run(cutoff)
  }
}
