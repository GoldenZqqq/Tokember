import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { IngestSuccessResponse } from '@tokember/contracts/usage'
import type { BuildInfo } from '@tokember/contracts/release'
import type { DB } from './db.js'
import { adminRoutes } from './admin-routes.js'
import { getStatsResponse, getYearStatsResponse } from './stats.js'
import { BUILD_INFO } from './build-info.js'
import { getLiveness, getReadiness, SERVER_STARTED_AT } from './health.js'
import {
  decodeIngestBody,
  INGEST_MAX_BODY_BYTES,
  ingestUsageBatch,
  IngestRequestError,
  isSub2ApiIdentity,
} from './ingest.js'
import {
  COLLECTOR_RUN_MAX_BODY_BYTES,
  CollectorRunRequestError,
  decodeCollectorRunReport,
  upsertCollectorRun,
} from './collector-runs.js'
import {
  commitSourceCutover,
  getSourceAuthorities,
  getSourceAuthority,
  parseCutoverAt,
  parseSourceProvider,
  parseSourceProviders,
} from './source-authority.js'
import { AuditRequestError, getAuditRecords } from './audit.js'
import { DeviceCredentialService } from './security/device-credentials.js'
import { LoginService } from './security/login.js'
import { registerViewerRoutes } from './security/routes.js'
import { SessionService } from './security/session.js'
import type { SecurityEnv } from './security/types.js'
import { parseMachineMetadata } from './device.js'
import {
  applyDeviceRekey,
  DeviceRekeyError,
  planDeviceRekey,
} from './device-migration.js'
import {
  isProtocolCompatible,
  parseClientProtocolVersion,
  protocolIncompatibleBody,
} from './protocol.js'

function registerDeviceRoutes(
  api: Hono<SecurityEnv>,
  db: DB,
  credentials: DeviceCredentialService,
): void {
  api.post('/devices/rekey', credentials.requireCredential(), async c => {
    const body = await c.req.json().catch(() => null)
    const sourceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
    const targetId = typeof body?.target_device_id === 'string'
      ? body.target_device_id.trim() : ''
    const targetName = typeof body?.target_name === 'string' ? body.target_name.trim() : ''
    if (!credentials.matchesDevice(c, sourceId)) {
      return c.json({ error: 'device_credential_mismatch' }, 403)
    }
    try {
      const plan = planDeviceRekey(db, sourceId, targetId, targetName)
      if (body?.apply !== true) return c.json({ ok: true, applied: false, plan })
      if (body?.backup_confirmed !== true) {
        return c.json({ error: 'backup_required' }, 400)
      }
      return c.json({ ok: true, ...applyDeviceRekey(db, plan) })
    } catch (error) {
      if (error instanceof DeviceRekeyError) {
        const status = error.code === 'source_not_found' ? 404
          : error.code === 'target_exists' ? 409 : 400
        return c.json({ error: error.code }, status)
      }
      console.error('[devices/rekey] migration failed', error instanceof Error ? error.name : 'unknown')
      return c.json({ error: 'device rekey failed' }, 500)
    }
  })

  // Registration is only a heartbeat; completed runs use /collector-runs.
  api.post('/devices', credentials.requireCredential(), async (c) => {
    const body = await c.req.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!id || !name) return c.json({ error: 'id and name required' }, 400)
    if (!credentials.matchesDevice(c, id)) {
      return c.json({ error: 'device_credential_mismatch' }, 403)
    }
    if (isSub2ApiIdentity(id)) {
      return c.json({ error: 'Sub2API is a billing gateway and is not an activity source' }, 410)
    }
    const clientProtocol = parseClientProtocolVersion(body?.protocol_version)
    if (!isProtocolCompatible(clientProtocol)) {
      return c.json(protocolIncompatibleBody(clientProtocol), 426)
    }
    const nativeSources = parseSourceProviders(body?.native_sources)
    if (!nativeSources) return c.json({ error: 'native_sources must contain claude/codex' }, 400)
    const machine = parseMachineMetadata(body)
    if (!machine) return c.json({ error: 'invalid machine metadata' }, 400)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO devices
        (id, name, last_seen_at, platform, architecture, hostname)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        prev_seen_at = devices.last_seen_at,
        last_seen_at = excluded.last_seen_at,
        platform = COALESCE(excluded.platform, devices.platform),
        architecture = COALESCE(excluded.architecture, devices.architecture),
        hostname = COALESCE(excluded.hostname, devices.hostname)
    `).run(
      id, name, now, machine.platform, machine.architecture, machine.hostname,
    )
    return c.json({
      ok: true,
      protocol_version: clientProtocol,
      source_authority: getSourceAuthorities(db, id, nativeSources),
    })
  })
}

function registerSourceCutoverRoutes(
  api: Hono<SecurityEnv>,
  db: DB,
  credentials: DeviceCredentialService,
): void {
  api.get('/source-cutovers', credentials.requireCredential(), (c) => {
    const deviceId = c.req.query('device_id')
    const provider = parseSourceProvider(c.req.query('provider'))
    if (!deviceId || !provider) return c.json({ error: 'valid device_id and provider required' }, 400)
    if (!credentials.matchesDevice(c, deviceId)) {
      return c.json({ error: 'device_credential_mismatch' }, 403)
    }
    return c.json({ authority: getSourceAuthority(db, deviceId, provider) })
  })

  api.post('/source-cutovers', credentials.requireCredential(), async (c) => {
    const body = await c.req.json().catch(() => null)
    const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
    const provider = parseSourceProvider(body?.provider)
    const cutoverAt = parseCutoverAt(body?.cutover_at)
    if (!deviceId || !provider || !cutoverAt) {
      return c.json({ error: 'valid device_id, provider and UTC cutover_at required' }, 400)
    }
    if (!credentials.matchesDevice(c, deviceId)) {
      return c.json({ error: 'device_credential_mismatch' }, 403)
    }
    const result = commitSourceCutover(db, deviceId, provider, cutoverAt)
    if (result === 'missing-device') return c.json({ error: 'device not found' }, 404)
    if (result === 'conflict') return c.json({ error: 'cutover already committed' }, 409)
    return c.json({ ok: true, created: result === 'created', authority: getSourceAuthority(db, deviceId, provider) })
  })
}

function registerIngestRoute(
  api: Hono<SecurityEnv>,
  db: DB,
  credentials: DeviceCredentialService,
): void {
  api.post(
    '/ingest',
    credentials.requireCredential(),
    bodyLimit({
      maxSize: INGEST_MAX_BODY_BYTES,
      onError: c => c.json({
        error: 'payload is too large', code: 'payload_too_large',
      }, 413),
    }),
    async (c) => {
      let raw: unknown
      try {
        raw = await c.req.json()
      } catch {
        return c.json({ error: 'invalid JSON', code: 'invalid_json' }, 400)
      }
      try {
        const batch = decodeIngestBody(raw)
        if (!credentials.matchesDevice(c, batch.device_id)) {
          return c.json({ error: 'device_credential_mismatch' }, 403)
        }
        const result = ingestUsageBatch(db, batch)
        const response: IngestSuccessResponse = { ok: true, ...result }
        return c.json(response)
      } catch (error) {
        if (error instanceof IngestRequestError) {
          return c.json(error.toResponse(), error.status)
        }
        console.error('[ingest] transaction failed', error instanceof Error ? error.name : 'unknown')
        return c.json({ error: 'ingest failed', code: 'ingest_failed' }, 500)
      }
    },
  )
}

function registerCollectorRunRoute(
  api: Hono<SecurityEnv>,
  db: DB,
  credentials: DeviceCredentialService,
): void {
  api.post(
    '/collector-runs',
    credentials.requireCredential(),
    bodyLimit({
      maxSize: COLLECTOR_RUN_MAX_BODY_BYTES,
      onError: c => c.json({
        error: 'payload is too large', code: 'payload_too_large',
      }, 413),
    }),
    async c => {
      let raw: unknown
      try {
        raw = await c.req.json()
      } catch {
        return c.json({ error: 'invalid JSON', code: 'invalid_json' }, 400)
      }
      try {
        const report = decodeCollectorRunReport(raw)
        if (!credentials.matchesDevice(c, report.device_id)) {
          return c.json({ error: 'device_credential_mismatch' }, 403)
        }
        const result = upsertCollectorRun(db, report)
        if (result === 'missing-device') {
          return c.json({ error: 'device not found', code: 'device_not_found' }, 404)
        }
        if (result === 'device-conflict') {
          return c.json({ error: 'run belongs to another device', code: 'run_device_conflict' }, 409)
        }
        return c.json({ ok: true, run_id: report.run_id, created: result === 'created' })
      } catch (error) {
        if (error instanceof CollectorRunRequestError) {
          return c.json({ error: 'invalid collector run', code: error.code, field: error.field }, 400)
        }
        console.error('[collector-runs] transaction failed', error instanceof Error ? error.name : 'unknown')
        return c.json({ error: 'collector run failed', code: 'collector_run_failed' }, 500)
      }
    },
  )
}

interface ApiRouteOptions {
  buildInfo?: BuildInfo
  env?: NodeJS.ProcessEnv
  startedAt?: string
}

function registerHealthRoutes(api: Hono<SecurityEnv>, db: DB, options: ApiRouteOptions): void {
  const buildInfo = options.buildInfo ?? BUILD_INFO
  api.get('/health/live', c => c.json(getLiveness(
    buildInfo, options.startedAt ?? SERVER_STARTED_AT,
  )))
  api.get('/health/ready', c => {
    const result = getReadiness(db, buildInfo, { env: options.env })
    return result.status === 'ready' ? c.json(result) : c.json(result, 503)
  })
}

function registerStatsRoutes(
  api: Hono<SecurityEnv>,
  db: DB,
  sessions: SessionService,
): void {
  api.get('/stats', sessions.requireViewer(), (c) => {
    return c.json(getStatsResponse(db, c.req.query()))
  })
  api.get('/stats/year', sessions.requireViewer(), (c) => {
    return c.json(getYearStatsResponse(db, c.req.query()))
  })
}

function registerReadRoutes(
  api: Hono<SecurityEnv>,
  db: DB,
  sessions: SessionService,
): void {
  api.get('/records', sessions.requireViewer(), (c) => {
    try {
      return c.json(getAuditRecords(db, c.req.query(), false))
    } catch (error) {
      if (error instanceof AuditRequestError) return c.json(error.toResponse(), 400)
      console.error('[records] read failed', error instanceof Error ? error.name : 'unknown')
      return c.json({ error: 'records read failed', code: 'records_read_failed' }, 500)
    }
  })

  // List devices
  api.get('/devices', sessions.requireViewer(), (c) => {
    const devices = db.prepare('SELECT * FROM devices ORDER BY name').all()
    return c.json(devices)
  })
}

export function apiRoutes(db: DB, dbPath?: string, options: ApiRouteOptions = {}) {
  const api = new Hono<SecurityEnv>()
  const env = options.env ?? process.env
  const sessions = new SessionService(db, env)
  const login = new LoginService(db, sessions, env)
  const credentials = new DeviceCredentialService(db, env)
  registerHealthRoutes(api, db, options)
  registerViewerRoutes(api, sessions, login)
  api.route('/admin', adminRoutes(
    db, dbPath, options.buildInfo ?? BUILD_INFO, { sessions, login, credentials },
  ))
  registerDeviceRoutes(api, db, credentials)
  registerSourceCutoverRoutes(api, db, credentials)
  registerIngestRoute(api, db, credentials)
  registerCollectorRunRoute(api, db, credentials)
  registerStatsRoutes(api, db, sessions)
  registerReadRoutes(api, db, sessions)

  return api
}
