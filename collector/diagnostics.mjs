import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform as hostPlatform, arch as hostArch } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_IDS = [
  'claude', 'codex', 'cursor', 'gemini', 'grok-build', 'cline',
  'roo-code', 'antigravity', 'openclaw', 'pi', 'omp', 'hermes',
]
const ADAPTIVE_BANDS = new Set(['active', 'recent', 'idle', 'failure_backoff'])
const SAFE_SCHEDULER_STATES = new Set(['enabled', 'disabled', 'not_installed', 'unsupported', 'unknown'])
const RUNTIME_MODES = new Set(['dist', 'tsx', 'missing'])

function canonicalPlatform(value) {
  if (value === 'win32') return 'windows'
  if (value === 'darwin') return 'macos'
  if (value === 'linux') return 'linux'
  return 'other'
}

function envValue(env, keys) {
  for (const key of keys) {
    const value = typeof env[key] === 'string' ? env[key].trim() : ''
    if (value) return value
  }
  return ''
}

function readEnvFile(path, read = readFileSync) {
  try {
    const values = {}
    for (const line of String(read(path, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/)
      if (match) values[match[1]] = match[2]
    }
    return values
  } catch {
    return {}
  }
}

function sourcePaths(env, home, platform) {
  const appData = env.APPDATA || (platform === 'windows'
    ? join(home, 'AppData', 'Roaming')
    : platform === 'macos'
      ? join(home, 'Library', 'Application Support')
      : join(home, '.config'))
  const cursor = env.CURSOR_DB || (platform === 'windows'
    ? join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    : platform === 'macos'
      ? join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      : join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  const codeRoots = [
    join(appData, 'Code', 'User', 'globalStorage'),
    join(appData, 'Code - Insiders', 'User', 'globalStorage'),
    join(appData, 'VSCodium', 'User', 'globalStorage'),
  ]
  const antigravity = env.ANTIGRAVITY_HOME || join(home, '.gemini')
  return {
    claude: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')],
    codex: [join(env.CODEX_HOME || join(home, '.codex'), 'sessions')],
    cursor: [cursor],
    gemini: [env.GEMINI_TMP_DIR || join(home, '.gemini', 'tmp')],
    'grok-build': [env.GROK_SESSIONS_DIR || join(env.GROK_HOME || join(home, '.grok'), 'sessions')],
    cline: codeRoots.map(root => join(root, 'saoudrizwan.claude-dev', 'tasks')),
    'roo-code': codeRoots.map(root => join(root, 'rooveterinaryinc.roo-cline', 'tasks')),
    antigravity: [
      join(antigravity, 'antigravity', 'conversations'),
      join(antigravity, 'antigravity-cli', 'conversations'),
      join(antigravity, 'antigravity-cli', 'implicit'),
      join(antigravity, 'antigravity-ide', 'conversations'),
      join(antigravity, 'antigravity-ide', 'implicit'),
    ],
    openclaw: [env.OPENCLAW_STATE_DIR || join(home, '.openclaw')],
    pi: [env.PI_AGENT_SESSIONS_DIR || env.PI_SESSIONS_DIR || join(home, '.pi', 'agent', 'sessions')],
    omp: [env.OMP_SESSIONS_DIR || join(home, '.omp', 'agent', 'sessions')],
    hermes: [env.HERMES_DB || join(home, '.hermes', 'state.db')],
  }
}

function runtimeMode(collectorDir, exists) {
  if (exists(join(collectorDir, 'dist', 'index.js'))) return 'dist'
  if (exists(join(collectorDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'))) return 'tsx'
  return 'missing'
}

function parseAdaptiveState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== 1 || !ADAPTIVE_BANDS.has(value.band)) return null
  if (!Number.isSafeInteger(value.consecutive_failures) || value.consecutive_failures < 0) return null
  return {
    version: 1,
    band: value.band,
    failure_count: value.consecutive_failures,
  }
}

function adaptiveState(env, home, exists, read = readFileSync) {
  const configured = env.TOKEMBER_ADAPTIVE_STATE?.trim()
  const canonical = join(home, '.tokember', 'adaptive-schedule.json')
  const legacy = join(home, '.ai-burn', 'adaptive-schedule.json')
  const path = configured || (exists(canonical) ? canonical : legacy)
  try {
    return parseAdaptiveState(JSON.parse(String(read(path, 'utf8'))))
  } catch {
    return null
  }
}

function commandStatus(command, args, run = spawnSync) {
  try {
    const result = run(command, args, { encoding: 'utf8', windowsHide: true })
    return { code: result.status ?? 1, stdout: String(result.stdout || '') }
  } catch {
    return { code: 127, stdout: '' }
  }
}

function detectScheduler(platform, home, exists, run) {
  if (platform === 'windows') {
    for (const name of ['tokember-collector', 'ai-burn-collector']) {
      const result = commandStatus('schtasks.exe', ['/Query', '/TN', name, '/XML'], run)
      if (result.code === 0) return /<Enabled>\s*false\s*<\/Enabled>/i.test(result.stdout) ? 'disabled' : 'enabled'
    }
    return 'not_installed'
  }
  if (platform === 'linux') {
    const result = commandStatus('systemctl', ['--user', 'is-enabled', 'tokember-collector.timer'], run)
    const value = result.stdout.trim()
    if (value === 'enabled') return 'enabled'
    if (['disabled', 'masked', 'static', 'indirect'].includes(value)) return 'disabled'
    return 'not_installed'
  }
  if (platform === 'macos') {
    const plist = join(home, 'Library', 'LaunchAgents', 'com.tokember.collector.plist')
    if (!exists(plist)) return 'not_installed'
    const result = commandStatus('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/com.tokember.collector`], run)
    return result.code === 0 ? 'enabled' : 'disabled'
  }
  return 'unsupported'
}

export function buildDiagnosticReport(options = {}) {
  const rawPlatform = options.platform ?? hostPlatform()
  const platform = canonicalPlatform(rawPlatform)
  const env = { ...process.env, ...(options.env || {}) }
  const home = options.home ?? homedir()
  const collectorDir = options.collectorDir ?? dirname(fileURLToPath(import.meta.url))
  const exists = options.exists ?? existsSync
  const configPath = join(collectorDir, 'collector.env')
  const fileEnv = readEnvFile(configPath, options.read ?? readFileSync)
  const merged = { ...fileEnv, ...env }
  const nodeMajor = Number.parseInt((options.nodeVersion ?? process.versions.node).split('.')[0], 10)
  const sources = sourcePaths(merged, home, platform)
  const sourceStatus = Object.fromEntries(SOURCE_IDS.map(source => [
    source, sources[source].some(path => exists(path)),
  ]))
  const server = envValue(merged, ['TOKEMBER_SERVER', 'AI_BURN_SERVER'])
  const credential = envValue(merged, [
    'TOKEMBER_DEVICE_TOKEN', 'TOKEMBER_API_KEY', 'AI_BURN_API_KEY', 'API_KEY',
  ])
  const schedule = envValue(merged, ['TOKEMBER_SCHEDULE_MODE', 'AI_BURN_SCHEDULE_MODE'])
  const scheduler = options.schedulerStatus
    ?? detectScheduler(platform, home, exists, options.run ?? spawnSync)
  const status = SAFE_SCHEDULER_STATES.has(scheduler) ? scheduler : 'unknown'
  const runtime = options.runtimeMode ?? runtimeMode(collectorDir, exists)
  return {
    schema_version: 1,
    generated_at: (options.now ?? new Date()).toISOString(),
    platform,
    architecture: options.architecture ?? hostArch(),
    node: { major: Number.isInteger(nodeMajor) ? nodeMajor : 0, supported: nodeMajor >= 22 },
    runtime: { mode: RUNTIME_MODES.has(runtime) ? runtime : 'missing' },
    config: {
      present: exists(configPath),
      server_configured: Boolean(server && !/^https:\/\/tokember\.example\/?$/.test(server)),
      credential_configured: Boolean(credential),
      schedule_mode: schedule === 'adaptive' || schedule === 'fixed' ? schedule : 'unknown',
    },
    sources: sourceStatus,
    scheduler: { status },
    adaptive: adaptiveState(merged, home, exists, options.read ?? readFileSync),
  }
}

export async function writeDiagnosticReport(output, options = {}) {
  if (!output || typeof output !== 'string') throw new Error('--output requires a file path')
  const { open, chmod } = await import('node:fs/promises')
  const report = buildDiagnosticReport(options)
  const flags = options.overwrite ? 'w' : 'wx'
  const handle = await open(output, flags, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(output, 0o600).catch(() => {})
  return report
}
