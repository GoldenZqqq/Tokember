// Adapted from getagentseal/codeburn's MIT-licensed Antigravity provider.

import { execFile } from 'child_process'
import https from 'https'

import type { UsageRecord } from '../types.js'
import { canonicalAntigravityModel } from './model.js'
import type { AntigravityApp, GeneratorMetadata, ServerInfo } from './types.js'

const RPC_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const PORT_FLAGS = ['https_server_port', 'extension_server_port', 'https-server-port', 'extension-server-port']
const TOKEN_FLAGS = ['csrf_token', 'extension_server_csrf_token', 'csrf-token', 'extension-server-csrf-token']
const DATA_FLAGS = ['app_data_dir', 'app-data-dir']

interface ServerCandidate extends ServerInfo {
  app?: AntigravityApp
}

type ModelMap = Record<string, string>
const detected = new Map<AntigravityApp, ServerInfo | null>()
const modelMaps = new Map<string, ModelMap>()
const agent = new https.Agent({ rejectUnauthorized: false })

function execText(command: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

function flagValue(line: string, names: string[]): string | null {
  for (const name of names) {
    const match = line.match(new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i'))
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value && !value.startsWith('--')) return value
  }
  return null
}

function normalizeApp(value: string | null): AntigravityApp | undefined {
  const normalized = value?.replace(/\\/g, '/').toLowerCase()
  if (normalized?.includes('antigravity-ide')) return 'antigravity-ide'
  if (normalized?.includes('antigravity-cli')) return 'antigravity-cli'
  if (normalized?.includes('antigravity')) return 'antigravity'
  return undefined
}

export function parseAntigravityServerCandidate(line: string): ServerCandidate | null {
  const lower = line.toLowerCase()
  if (!lower.includes('language_server') || !lower.includes('antigravity')) return null
  const rawPort = flagValue(line, PORT_FLAGS)
  const csrfToken = flagValue(line, TOKEN_FLAGS)
  if (!rawPort || !csrfToken || csrfToken.length < 16
    || !/^[A-Za-z0-9._~:/+=-]+$/.test(csrfToken)) return null
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null
  return { port, csrfToken, app: normalizeApp(flagValue(line, DATA_FLAGS)) }
}

async function processLines(): Promise<string[]> {
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*'} | ForEach-Object {$_.CommandLine}"
    return (await execText('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ])).split(/\r?\n/)
  }
  return (await execText('ps', ['-ww', '-eo', 'args'])).split('\n')
}

async function resolveWindowsPort(candidate: ServerCandidate): Promise<number | null> {
  const processScript = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*'} | ForEach-Object {(@{PID=$_.ProcessId;Cmd=$_.CommandLine}|ConvertTo-Json -Compress)}"
  const output = await execText('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', processScript,
  ])
  let pid = 0
  for (const line of output.split(/\r?\n/)) {
    try {
      const item = JSON.parse(line) as { PID?: number; Cmd?: string }
      const parsed = item.Cmd ? parseAntigravityServerCandidate(item.Cmd) : null
      if (parsed?.csrfToken === candidate.csrfToken) pid = item.PID ?? 0
    } catch { /* ignore unrelated process output */ }
  }
  if (!pid) return null
  const ports = await execText('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -State Listen -OwningProcess ${pid} | Select-Object -ExpandProperty LocalPort`,
  ])
  for (const value of ports.split(/\r?\n/)) {
    const port = Number(value.trim())
    if (Number.isInteger(port) && port > 0 && await probePort(port, candidate.csrfToken)) return port
  }
  return null
}

async function resolvePosixPort(candidate: ServerCandidate): Promise<number | null> {
  const output = await execText('ps', ['-ww', '-eo', 'pid=,args='])
  let pid = ''
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    const parsed = match ? parseAntigravityServerCandidate(match[2]!) : null
    if (parsed?.csrfToken === candidate.csrfToken) {
      pid = match![1]!
      break
    }
  }
  if (!pid) return null
  const listeners = await execText('lsof', ['-a', '-i', '-P', '-n', '-p', pid])
  for (const line of listeners.split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/)
    const port = Number(match?.[1])
    if (Number.isInteger(port) && port > 0 && await probePort(port, candidate.csrfToken)) return port
  }
  return null
}

async function probePort(port: number, csrfToken: string): Promise<boolean> {
  try {
    await antigravityRpc({ port, csrfToken }, 'GetAvailableModels')
    return true
  } catch {
    return false
  }
}

export async function detectAntigravityServer(app: AntigravityApp): Promise<ServerInfo | null> {
  if (detected.has(app)) return detected.get(app)!
  try {
    const candidates = (await processLines())
      .map(parseAntigravityServerCandidate)
      .filter((item): item is ServerCandidate => item != null)
    const candidate = candidates.find(item => item.app === app)
      ?? (app === 'antigravity' ? candidates.find(item => item.app == null) : undefined)
    if (!candidate) {
      detected.set(app, null)
      return null
    }
    if (candidate.port > 0) {
      const result = { port: candidate.port, csrfToken: candidate.csrfToken }
      detected.set(app, result)
      return result
    }
    const port = process.platform === 'win32'
      ? await resolveWindowsPort(candidate)
      : await resolvePosixPort(candidate)
    const result = port ? { port, csrfToken: candidate.csrfToken } : null
    detected.set(app, result)
    return result
  } catch { /* process discovery is best-effort */ }
  detected.set(app, null)
  return null
}

export async function antigravityRpc(
  server: ServerInfo,
  method: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = https.request({
      hostname: '127.0.0.1', port: server.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST', agent, timeout: RPC_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': server.csrfToken,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy()
          reject(new Error(`Antigravity RPC ${method} response too large`))
        } else chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Antigravity RPC HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown) }
        catch { reject(new Error('Antigravity RPC returned invalid JSON')) }
      })
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('Antigravity RPC timeout')))
    request.on('error', reject)
    request.end(payload)
  })
}

export function extractGeneratorMetadata(value: unknown): GeneratorMetadata[] {
  if (!value || typeof value !== 'object') return []
  const data = value as { generatorMetadata?: unknown; response?: { generatorMetadata?: unknown } }
  const metadata = data.response?.generatorMetadata ?? data.generatorMetadata
  return Array.isArray(metadata)
    ? metadata.filter(item => item != null && typeof item === 'object') as GeneratorMetadata[]
    : []
}

export function extractModelMap(value: unknown): ModelMap {
  if (!value || typeof value !== 'object') return {}
  const data = value as { models?: unknown; response?: { models?: unknown } }
  const models = data.response?.models ?? data.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return {}
  const result: ModelMap = {}
  for (const [key, item] of Object.entries(models)) {
    if (!item || typeof item !== 'object') continue
    const model = (item as { model?: unknown }).model
    const display = (item as { displayName?: unknown }).displayName
    if (typeof model === 'string') {
      result[model] = canonicalAntigravityModel(key, typeof display === 'string' ? display : undefined)
    }
  }
  return result
}

function token(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function recordsFromGeneratorMetadata(
  cascadeId: string,
  metadata: GeneratorMetadata[],
  modelMap: ModelMap,
  fallbackTimestamp: string,
): UsageRecord[] {
  const records: UsageRecord[] = []
  metadata.forEach((entry, index) => {
    const usage = entry.chatModel?.usage
    if (!usage) return
    const input = token(usage.inputTokens)
    const totalOutput = token(usage.outputTokens)
    const reasoning = token(usage.thinkingOutputTokens)
    let output = token(usage.responseOutputTokens)
    if (output === 0 && reasoning === 0) output = totalOutput
    else if (totalOutput > 0 && output + reasoning !== totalOutput) output = Math.max(0, totalOutput - reasoning)
    if (input === 0 && totalOutput === 0) return
    const responseId = usage.responseId || String(index)
    const rawModel = usage.model ?? 'unknown'
    records.push({
      provider: 'antigravity', model: modelMap[rawModel] ?? rawModel,
      input_tokens: input, output_tokens: output,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      reasoning_tokens: reasoning, cost_usd: 0,
      timestamp: entry.chatModel?.chatStartMetadata?.createdAt ?? fallbackTimestamp,
      source_file: cascadeId,
      dedup_key: `antigravity:${cascadeId}:${responseId}`,
      attribution: { status: 'captured', session: cascadeId },
    })
  })
  return records
}

export async function collectAntigravityRpcRecords(
  app: AntigravityApp,
  cascadeId: string,
  fallbackTimestamp: string,
): Promise<UsageRecord[]> {
  const server = await detectAntigravityServer(app)
  if (!server) return []
  const key = `${server.port}:${server.csrfToken}`
  let modelMap = modelMaps.get(key)
  if (!modelMap) {
    modelMap = extractModelMap(await antigravityRpc(server, 'GetAvailableModels').catch(() => ({})))
    modelMaps.set(key, modelMap)
  }
  const response = await antigravityRpc(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId })
  return recordsFromGeneratorMetadata(cascadeId, extractGeneratorMetadata(response), modelMap, fallbackTimestamp)
}
