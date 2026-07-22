import type { Context, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { configuredCorsOrigins, trustProxy } from '../config.js'

function normalizeOrigin(value: string): string | null {
  if (value.includes('*')) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function configuredOrigins(env: NodeJS.ProcessEnv): Set<string> {
  const result = new Set<string>()
  for (const value of configuredCorsOrigins(env)) {
    const normalized = normalizeOrigin(value)
    if (!normalized) throw new Error('TOKEMBER_CORS_ORIGINS contains an invalid origin')
    result.add(normalized)
  }
  return result
}

function effectiveOrigin(c: Context, env: NodeJS.ProcessEnv): string {
  if (!trustProxy(env)) return new URL(c.req.url).origin
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  if (!forwardedHost || !['http', 'https'].includes(forwardedProto ?? '')) {
    return new URL(c.req.url).origin
  }
  return `${forwardedProto}://${forwardedHost}`
}

export function createCorsMiddleware(
  env: NodeJS.ProcessEnv = process.env,
): MiddlewareHandler {
  const allowlist = configuredOrigins(env)
  const allowed = (origin: string, c: Context): boolean => {
    const normalized = normalizeOrigin(origin)
    return normalized != null
      && (normalized === effectiveOrigin(c, env) || allowlist.has(normalized))
  }
  const applyCors = cors({
    origin: (origin, c) => allowed(origin, c) ? normalizeOrigin(origin) : null,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true,
    maxAge: 600,
  })
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin) return next()
    if (!allowed(origin, c)) return c.json({ error: 'origin_not_allowed' }, 403)
    return applyCors(c, next)
  }
}
