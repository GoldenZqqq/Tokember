import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type {
  DeviceCredential,
  DeviceCredentialCreatedResponse,
  DeviceCredentialInput,
  DeviceCredentialListResponse,
} from '@tokember/contracts/security'
import { allowLegacyApiKey, configuredApiKey } from '../config.js'
import type { DB } from '../db.js'
import type { CollectorPrincipal, SecurityEnv } from './types.js'

const TOKEN_PATTERN = /^tkdc_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/

interface CredentialRow {
  id: number
  token_id: string
  device_id: string
  device_name: string
  label: string
  secret_hash: string
  created_at: string
  last_used_at: string | null
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

export function extractBearer(
  authorization?: string | null,
  xApiKey?: string | null,
): string | null {
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1].trim()
  }
  return xApiKey?.trim() || null
}

function publicCredential(row: CredentialRow): DeviceCredential {
  return {
    id: row.id, token_id: row.token_id, device_id: row.device_id,
    device_name: row.device_name, label: row.label, created_at: row.created_at,
    last_used_at: row.last_used_at, revoked_at: row.revoked_at,
  }
}

function decodeInput(value: unknown): DeviceCredentialInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const deviceId = typeof raw.device_id === 'string' ? raw.device_id.trim() : ''
  const deviceName = typeof raw.device_name === 'string' ? raw.device_name.trim() : undefined
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (!deviceId || deviceId.length > 128 || !label || label.length > 120) return null
  if (deviceName !== undefined && (!deviceName || deviceName.length > 160)) return null
  return { device_id: deviceId, device_name: deviceName, label }
}

function credentialSelect(): string {
  return `
    SELECT c.*, d.name AS device_name
    FROM device_credentials c JOIN devices d ON d.id = c.device_id
  `
}

export class DeviceCredentialService {
  constructor(
    private readonly db: DB,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  legacyAllowed(): boolean {
    return allowLegacyApiKey(this.env)
  }

  list(): DeviceCredentialListResponse {
    const rows = this.db.prepare(`${credentialSelect()} ORDER BY c.id DESC`).all() as CredentialRow[]
    return { credentials: rows.map(publicCredential), legacy_api_key_allowed: this.legacyAllowed() }
  }

  create(value: unknown, now = new Date()): DeviceCredentialCreatedResponse | null {
    const input = decodeInput(value)
    if (!input) return null
    return this.db.transaction(() => {
      this.ensureDevice(input)
      return this.insert(input.device_id, input.label, now)
    })()
  }

  rotate(id: number, now = new Date()): DeviceCredentialCreatedResponse | 'missing' {
    const row = this.db.prepare(`${credentialSelect()} WHERE c.id = ? AND c.revoked_at IS NULL`)
      .get(id) as CredentialRow | undefined
    if (!row) return 'missing'
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE device_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      `).run(now.toISOString(), id)
      return this.insert(row.device_id, row.label, now)
    })()
  }

  revoke(id: number, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE device_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(now.toISOString(), id).changes > 0
  }

  authenticate(token: string | null, now = new Date()): CollectorPrincipal | null {
    if (!token) {
      return this.legacyAllowed() && !configuredApiKey(this.env)
        && this.env.NODE_ENV !== 'production' ? { kind: 'legacy' } : null
    }
    const device = TOKEN_PATTERN.exec(token)
    if (device) return this.authenticateDevice(device[1], device[2], now)
    const legacy = configuredApiKey(this.env)
    if (!this.legacyAllowed()) return null
    if (!legacy) return this.env.NODE_ENV === 'production' ? null : { kind: 'legacy' }
    return safeEqual(token, legacy) ? { kind: 'legacy' } : null
  }

  requireCredential(): MiddlewareHandler<SecurityEnv> {
    return async (c, next) => {
      const token = extractBearer(c.req.header('authorization'), c.req.header('x-api-key'))
      const principal = this.authenticate(token)
      if (!principal) return c.json({ error: 'unauthorized' }, 401)
      c.set('collectorPrincipal', principal)
      await next()
    }
  }

  matchesDevice(c: Context<SecurityEnv>, deviceId: string): boolean {
    const principal = c.get('collectorPrincipal')
    return principal.kind === 'legacy' || principal.deviceId === deviceId
  }

  activeCount(): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM device_credentials WHERE revoked_at IS NULL
    `).get() as { count: number }).count
  }

  private ensureDevice(input: DeviceCredentialInput): void {
    const exists = this.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(input.device_id)
    if (exists) return
    if (!input.device_name) throw new Error('device_not_found')
    this.db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)')
      .run(input.device_id, input.device_name)
  }

  private insert(deviceId: string, label: string, now: Date): DeviceCredentialCreatedResponse {
    const tokenId = randomBytes(12).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    const result = this.db.prepare(`
      INSERT INTO device_credentials (token_id, device_id, label, secret_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenId, deviceId, label, hash(secret), now.toISOString())
    const row = this.db.prepare(`${credentialSelect()} WHERE c.id = ?`)
      .get(result.lastInsertRowid) as CredentialRow
    return { credential: publicCredential(row), token: `tkdc_${tokenId}_${secret}` }
  }

  private authenticateDevice(
    tokenId: string,
    secret: string,
    now: Date,
  ): CollectorPrincipal | null {
    const row = this.db.prepare(`
      SELECT id, device_id, secret_hash FROM device_credentials
      WHERE token_id = ? AND revoked_at IS NULL
    `).get(tokenId) as { id: number; device_id: string; secret_hash: string } | undefined
    if (!row || !safeEqual(hash(secret), row.secret_hash)) return null
    this.db.prepare('UPDATE device_credentials SET last_used_at = ? WHERE id = ?')
      .run(now.toISOString(), row.id)
    return { kind: 'device', credentialId: row.id, deviceId: row.device_id }
  }
}
