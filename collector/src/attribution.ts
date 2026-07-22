import { createHmac, randomBytes } from 'crypto'
import { chmod, mkdir, open, readFile } from 'fs/promises'
import { dirname, normalize, resolve } from 'path'

import type { UsageRecord } from './adapters/types.js'

const SECRET_BYTES = 32
const SECRET_LENGTH = 43

interface AttributionOptions {
  enabled: boolean
  secretFile: string
}

export interface AttributionEncoder {
  encode(record: UsageRecord): UsageRecord
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null
}

function canonicalPath(value: string): string {
  const path = normalize(resolve(value)).replaceAll('\\', '/')
  return process.platform === 'win32'
    ? path.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
    : path
}

function validSecret(value: string): boolean {
  return value.length === SECRET_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
}

async function readSecret(path: string): Promise<string> {
  const value = (await readFile(path, 'utf-8')).trim()
  if (!validSecret(value)) throw new Error('Attribution secret file is invalid')
  await chmod(path, 0o600).catch(() => {})
  return value
}

async function createSecret(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const value = randomBytes(SECRET_BYTES).toString('base64url')
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return readSecret(path)
    throw error
  }
  try {
    await handle.writeFile(`${value}\n`, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return value
}

async function loadSecret(path: string): Promise<string> {
  try {
    return await readSecret(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return createSecret(path)
    throw error
  }
}

function identifier(
  secret: string,
  domain: 'project' | 'session',
  provider: string,
  seed: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`tokember-attribution-v1\0${domain}\0${provider}\0${seed}`)
    .digest('base64url')
  return `${domain === 'project' ? 'prj' : 'ses'}_v1_${digest}`
}

function stripLocal(record: UsageRecord): UsageRecord {
  const { attribution: _localAttribution, ...wire } = record
  return wire
}

export async function createAttributionEncoder(
  options: AttributionOptions,
): Promise<AttributionEncoder> {
  if (!options.enabled) {
    return {
      encode: record => ({
        ...stripLocal(record), attribution_version: 1, attribution_status: 'disabled',
      }),
    }
  }
  const secret = await loadSecret(options.secretFile)
  return {
    encode(record) {
      const local = record.attribution
      const wire = stripLocal(record)
      if (!local || local.status === 'unsupported'
        || (!local.project?.value && !local.session)) {
        return { ...wire, attribution_version: 1, attribution_status: 'unsupported' }
      }
      const projectSeed = local.project?.kind === 'path'
        ? canonicalPath(local.project.value)
        : local.project?.value
      return {
        ...wire,
        attribution_version: 1,
        attribution_status: 'captured',
        ...(projectSeed
          ? { project_id: identifier(secret, 'project', record.provider, projectSeed) }
          : {}),
        ...(local.session
          ? { session_id: identifier(secret, 'session', record.provider, local.session) }
          : {}),
      }
    },
  }
}
