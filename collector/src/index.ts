import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import type { CollectorRunReport, CollectorSourceReport } from '@tokember/contracts/collector-observability'

import { CollectionObserver, type UsageRecord } from './adapters/types.js'
import { openReadOnly, type DatabaseHandle } from './adapters/sqlite-util.js'
import { ccSwitchRequestCountColumn, ccSwitchRollupToRecord } from './cc-switch.js'
import { collectClaude } from './adapters/claude.js'
import { collectCodex } from './adapters/codex.js'
import { collectCursor, getCursorDbPath } from './adapters/cursor.js'
import { collectGemini } from './adapters/gemini.js'
import { collectGrok } from './adapters/grok.js'
import { collectCline, collectRooCode } from './adapters/cline-roo.js'
import { collectAntigravity } from './adapters/antigravity/index.js'
import { collectOpenClaw, openClawProbePaths } from './adapters/openclaw.js'
import { collectOmp, collectPi, getOmpSessionsDir, getPiSessionsDir } from './adapters/pi.js'
import { parseClaudeCodexSourceMode } from './source-selection.js'
import { assertCollectorTarget, collectorConfig, configuredSourceMode } from './config.js'
import {
  decideAdmission,
  recordFailure,
  recordSuccess,
  promisedIntervalMinutes,
  type AdaptiveScheduleState,
} from './adaptive-policy.js'
import {
  acquireAdaptiveLock,
  loadAdaptiveState,
  saveAdaptiveState,
} from './adaptive-state.js'
import { probeActivity, type ActivityProbePlan } from './activity-probe.js'
import { createAttributionEncoder, type AttributionEncoder } from './attribution.js'
import {
  getCheckpoint,
  getIncrementalSourceState,
  loadCollectorState,
  saveCollectorState,
  type CollectorState,
} from './collector-state.js'
import {
  finalizableNativePlans,
  finalizeNativeProgress,
  planNativeCollection,
  type NativeCollectionPlan,
} from './native-transition.js'
import {
  applySuccessfulSourceStates,
  buildCollectorRunReport,
  collectObservableSources,
  failedCollectorRunReport,
  finishPendingRun,
  flushPendingRuns,
  getObservabilityStatePath,
  recoverAndBeginRun,
  sanitizeCollectorError,
  startCollectorRun,
  uploadObservableSources,
  type ObservableSource,
  type RunStart,
  type SourceCollection,
} from './collector-observability.js'
import {
  ServerClient,
  type NativeProvider,
  type SourceAuthorityMap,
} from './server-client.js'

const config = collectorConfig()
const client = new ServerClient(config.serverUrl, config.credential)
const NATIVE_PROVIDERS: NativeProvider[] = ['claude', 'codex']
const CLAUDE_CODEX_SOURCE = parseClaudeCodexSourceMode(configuredSourceMode())

function forceRequested(): boolean {
  return process.argv.includes('--force') || process.env.TOKEMBER_COLLECTOR_FORCE === '1'
}

function probeRoots(): Record<string, string[]> {
  const home = homedir()
  const cursorDb = getCursorDbPath()
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const codeRoots = [
    join(appData, 'Code', 'User', 'globalStorage'),
    join(appData, 'Code - Insiders', 'User', 'globalStorage'),
    join(appData, 'VSCodium', 'User', 'globalStorage'),
  ]
  const antigravityBase = process.env.ANTIGRAVITY_HOME ?? join(home, '.gemini')
  return {
    claude: [join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects')],
    codex: [join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions')],
    cursor: [cursorDb, `${cursorDb}-wal`],
    gemini: [process.env.GEMINI_TMP_DIR ?? join(home, '.gemini', 'tmp')],
    'grok-build': [process.env.GROK_SESSIONS_DIR ?? join(process.env.GROK_HOME ?? join(home, '.grok'), 'sessions')],
    cline: codeRoots.map(root => join(root, 'saoudrizwan.claude-dev', 'tasks')),
    'roo-code': codeRoots.map(root => join(root, 'rooveterinaryinc.roo-cline', 'tasks')),
    antigravity: [
      join(antigravityBase, 'antigravity', 'conversations'),
      join(antigravityBase, 'antigravity-cli', 'conversations'),
      join(antigravityBase, 'antigravity-cli', 'implicit'),
      join(antigravityBase, 'antigravity-ide', 'conversations'),
      join(antigravityBase, 'antigravity-ide', 'implicit'),
    ],
    openclaw: openClawProbePaths(),
    pi: [getPiSessionsDir()],
    omp: [getOmpSessionsDir()],
  }
}

function buildActivityProbePlans(state: CollectorState): ActivityProbePlan[] {
  const roots = probeRoots()
  const sources = Object.keys(roots)
  return sources.map(source => {
    const sourceState = incrementalState(state, source)
    const hotPaths = [
      ...Object.values(sourceState.files).map(file => file.path),
      ...Object.values(sourceState.directories).map(directory => directory.path),
    ]
    return { source, paths: [...new Set([...roots[source], ...hotPaths])] }
  })
}

function sameProbe(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => left[key] === right[key])
}

function getCcSwitchDbPath(): string {
  return process.env.CC_SWITCH_DB ?? join(homedir(), '.cc-switch', 'cc-switch.db')
}

function collectCcSwitchRollups(db: DatabaseHandle, observer: CollectionObserver): UsageRecord[] {
  const columns = db.prepare('PRAGMA table_info(usage_daily_rollups)')
    .all() as Array<{ name: string }>
  const requestCount = ccSwitchRequestCountColumn(columns.map(column => column.name))
  const rows = db.prepare(`
    SELECT date, app_type, model, provider_id, ${requestCount},
           input_tokens, output_tokens, cache_read_tokens,
           cache_creation_tokens, total_cost_usd
    FROM usage_daily_rollups
  `).all() as Record<string, unknown>[]
  observer.discover(rows.length)
  return rows.map(row => {
    const record = ccSwitchRollupToRecord(row)
    observer.scan(record.timestamp)
    return record
  })
}

function collectCcSwitchLogs(
  db: DatabaseHandle,
  boundary: string | null,
  observer: CollectionObserver,
): UsageRecord[] {
  const since = boundary
    ? Math.floor(new Date(`${boundary}T00:00:00.000Z`).getTime() / 1000) + 86_400
    : 0
  const rows = db.prepare(`
    SELECT request_id, app_type, model, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, total_cost_usd, created_at
    FROM proxy_request_logs WHERE created_at >= ?
  `).all(since)
  observer.discover(rows.length)
  return rows.map(row => {
    const input = Number(row.input_tokens ?? 0)
    const output = Number(row.output_tokens ?? 0)
    const createdAt = Number(row.created_at ?? 0)
    const timestamp = new Date(createdAt * 1000).toISOString()
    observer.scan(timestamp)
    return {
      provider: String(row.app_type ?? 'unknown'), model: String(row.model ?? 'unknown'),
      input_tokens: input, output_tokens: output,
      cache_read_tokens: Number(row.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
      reasoning_tokens: 0, cost_usd: Number(row.total_cost_usd) || 0,
      timestamp, source_file: 'cc-switch',
      dedup_key: `ccsw:${String(row.request_id ?? '')}:${createdAt}:${String(row.model ?? '')}:${input}:${output}`,
      attribution: { status: 'unsupported' },
    }
  })
}

async function collectCcSwitch(observer: CollectionObserver): Promise<UsageRecord[]> {
  let handle: Awaited<ReturnType<typeof openReadOnly>>
  try {
    handle = await openReadOnly(getCcSwitchDbPath())
  } catch {
    return []
  }
  try {
    const boundary = (handle.db.prepare('SELECT MAX(date) d FROM usage_daily_rollups')
      .get() as { d?: string | null })?.d ?? null
    return [
      ...collectCcSwitchRollups(handle.db, observer),
      ...collectCcSwitchLogs(handle.db, boundary, observer),
    ]
  } finally {
    await handle.cleanup()
  }
}

function incrementalState(state: CollectorState, source: string) {
  return getIncrementalSourceState(state, config.deviceId, source)
}

function independentSources(state: CollectorState): ObservableSource[] {
  return [
    { source: 'cursor', incremental_state: incrementalState(state, 'cursor'),
      collect: (observer, cursor) => collectCursor(observer, cursor) },
    { source: 'gemini', incremental_state: incrementalState(state, 'gemini'),
      collect: (observer, cursor) => collectGemini(observer, cursor) },
    { source: 'grok-build', incremental_state: incrementalState(state, 'grok-build'),
      collect: (observer, cursor) => collectGrok(undefined, observer, cursor) },
    { source: 'cline', incremental_state: incrementalState(state, 'cline'),
      collect: (observer, cursor) => collectCline(observer, cursor) },
    { source: 'roo-code', incremental_state: incrementalState(state, 'roo-code'),
      collect: (observer, cursor) => collectRooCode(observer, cursor) },
    { source: 'antigravity', incremental_state: incrementalState(state, 'antigravity'),
      collect: (observer, cursor) => collectAntigravity(undefined, observer, cursor) },
    { source: 'openclaw', incremental_state: incrementalState(state, 'openclaw'),
      collect: (observer, cursor) => collectOpenClaw(undefined, observer, cursor) },
    { source: 'pi', incremental_state: incrementalState(state, 'pi'),
      collect: (observer, cursor) => collectPi(undefined, observer, cursor) },
    { source: 'omp', incremental_state: incrementalState(state, 'omp'),
      collect: (observer, cursor) => collectOmp(undefined, observer, cursor) },
  ]
}

function nativeSources(
  plans: NativeCollectionPlan[],
  state: CollectorState,
): ObservableSource[] {
  return plans.map(plan => ({
    source: plan.provider,
    incremental_state: incrementalState(state, plan.provider),
    bootstrap_since: plan.bootstrap_since,
    collect: (observer, cursor) => plan.provider === 'claude'
      ? collectClaude(plan.window, observer, cursor)
      : collectCodex(plan.window, observer, cursor),
  }))
}

function buildNativePlans(
  authorities: SourceAuthorityMap,
  state: CollectorState,
  until: string,
): NativeCollectionPlan[] {
  const legacyAvailable = existsSync(getCcSwitchDbPath())
  return NATIVE_PROVIDERS.map(provider => {
    const authority = authorities[provider]
    if (!authority) throw new Error(`Server omitted ${provider} source authority`)
    if (authority.legacy_history && !authority.cutover_at && !legacyAvailable) {
      console.warn(`  ${provider}: local cc-switch DB missing; resuming from server legacy coverage`)
    }
    return planNativeCollection({
      authority,
      checkpoint: getCheckpoint(state, config.deviceId, provider),
      until,
      legacyAvailable,
    })
  })
}

function failedStateReport(error: unknown): CollectorSourceReport {
  return {
    source: 'collector-state', status: 'collection_failed',
    discovered: 0, scanned: 0, emitted: 0, accepted: 0, unchanged: 0,
    watermark_at: null, last_usage_at: null, duration_ms: 0,
    error_summary: sanitizeCollectorError(error),
  }
}

function logSourceReports(reports: CollectorSourceReport[]): void {
  for (const report of reports) {
    const outcome = report.accepted == null
      ? 'ack unknown'
      : `${report.accepted} accepted / ${report.unchanged} unchanged`
    console.log(`  ${report.source}: ${report.status}; ${report.scanned}/${report.discovered} scanned; ${report.emitted} emitted; ${outcome}`)
    if (report.error_summary) console.error(`    ${report.error_summary}`)
  }
}

async function collectAndUpload(
  sources: ObservableSource[],
  attribution: AttributionEncoder,
): Promise<{
  collections: SourceCollection[]
  reports: CollectorSourceReport[]
}> {
  const collections = await collectObservableSources(sources)
  const reports = await uploadObservableSources(
    collections,
    records => client.ingest(
      config.deviceId, records.map(record => attribution.encode(record)),
    ),
  )
  return { collections, reports }
}

function hasSuccessfulStateCandidate(
  collections: SourceCollection[],
  reports: CollectorSourceReport[],
): boolean {
  const successful = new Set(
    reports.filter(report => report.status === 'success').map(report => report.source),
  )
  return collections.some(collection => (
    collection.state_candidate != null && successful.has(collection.source)
  ))
}

async function runLegacyMode(attribution: AttributionEncoder): Promise<CollectorSourceReport[]> {
  const state = await loadCollectorState()
  const result = await collectAndUpload([
    { source: 'cc-switch', collect: collectCcSwitch },
    ...independentSources(state),
  ], attribution)
  try {
    if (hasSuccessfulStateCandidate(result.collections, result.reports)) {
      await finalizeNativeProgress({
      plans: [], state, deviceId: config.deviceId, until: new Date().toISOString(),
      commit: async () => {},
      stage: candidate => applySuccessfulSourceStates({
        state: candidate, deviceId: config.deviceId,
        collections: result.collections, reports: result.reports,
      }),
      save: saveCollectorState,
      })
    }
  } catch (error) {
    result.reports.push(failedStateReport(error))
  }
  return result.reports
}

async function runNativeMode(
  authorities: SourceAuthorityMap,
  attribution: AttributionEncoder,
): Promise<CollectorSourceReport[]> {
  const until = new Date().toISOString()
  const state = await loadCollectorState()
  const plans = buildNativePlans(authorities, state, until)
  const sources = [...nativeSources(plans, state), ...independentSources(state)]
  if (plans.some(plan => plan.collect_legacy)) {
    const providers = new Set(plans.filter(plan => plan.collect_legacy).map(plan => plan.provider))
    sources.push({
      source: 'cc-switch',
      collect: async observer => (await collectCcSwitch(observer))
        .filter(record => providers.has(record.provider as NativeProvider)),
    })
  }
  const { collections, reports } = await collectAndUpload(sources, attribution)
  const successful = new Set(
    reports.filter(report => report.status === 'success').map(report => report.source),
  )
  const ready = finalizableNativePlans(plans, successful)
  try {
    if (ready.length > 0 || hasSuccessfulStateCandidate(collections, reports)) {
      await finalizeNativeProgress({
      plans: ready, state, deviceId: config.deviceId, until,
      commit: async (provider, cutoverAt) => {
        await client.commitCutover(config.deviceId, provider, cutoverAt)
        console.log(`  ${provider} cutover committed at ${cutoverAt}`)
      },
      stage: candidate => applySuccessfulSourceStates({
        state: candidate, deviceId: config.deviceId, collections, reports,
      }),
      save: saveCollectorState,
      })
    }
  } catch (error) {
    reports.push(failedStateReport(error))
  }
  return reports
}

async function flushTelemetry(path: string): Promise<void> {
  try {
    const sent = await flushPendingRuns(report => client.reportRun(report), path)
    if (sent > 0) console.log(`  telemetry: ${sent} run report(s) acknowledged`)
  } catch (error) {
    console.warn(`  telemetry flush deferred: ${sanitizeCollectorError(error)}`)
  }
}

async function queueReport(report: CollectorRunReport, path: string): Promise<boolean> {
  try {
    await finishPendingRun(report, path)
    return true
  } catch (error) {
    console.warn(`  telemetry queue failed: ${sanitizeCollectorError(error)}`)
    return false
  }
}

async function beginRun(start: RunStart, path: string): Promise<void> {
  try {
    await recoverAndBeginRun(start, path)
  } catch (error) {
    console.warn(`  telemetry start persistence failed: ${sanitizeCollectorError(error)}`)
  }
}

interface AdaptiveRunContext {
  lock: Awaited<ReturnType<typeof acquireAdaptiveLock>> & {}
  state: AdaptiveScheduleState
  signatures: Record<string, string>
  activityObserved: boolean
}

function logAdaptiveActivity(changedSources: string[], uncertainSources: string[]): void {
  const uncertainty = uncertainSources.length > 0
    ? `; uncertain=${uncertainSources.join(',')}`
    : ''
  console.log(`Adaptive activity detected: changed=${changedSources.join(',')}${uncertainty}`)
}

export async function prepareAdaptiveRun(selected: string): Promise<{
  run: boolean
  context: AdaptiveRunContext | null
}> {
  if (config.scheduleMode !== 'adaptive' || selected !== 'native') {
    return { run: true, context: null }
  }
  const lock = await acquireAdaptiveLock()
  if (!lock) {
    console.log('Adaptive tick skipped: collector already running')
    return { run: false, context: null }
  }
  try {
    const [state, collectorState] = await Promise.all([
      loadAdaptiveState(), loadCollectorState(),
    ])
    const probe = await probeActivity(buildActivityProbePlans(collectorState), state.probe)
    const decision = decideAdmission(state, new Date(), {
      force: forceRequested(), activityObserved: probe.activityObserved,
    })
    if (decision.reason === 'activity') {
      logAdaptiveActivity(probe.changedSources, probe.uncertainSources)
    }
    if (!decision.run) {
      if (!sameProbe(state.probe, probe.signatures)) {
        await saveAdaptiveState({ ...state, probe: probe.signatures })
      }
      console.log('Adaptive tick skipped: next collection is not due')
      await lock.release()
      return { run: false, context: null }
    }
    return {
      run: true,
      context: {
        lock, state, signatures: probe.signatures,
        activityObserved: probe.activityObserved,
      },
    }
  } catch (error) {
    await lock.release()
    throw error
  }
}

async function executeCollector(
  selected: string,
  start: RunStart,
  outboxPath: string,
): Promise<{ report: CollectorRunReport; registered: boolean; failure: Error | null }> {
  await beginRun(start, outboxPath)
  let registered = false
  let report: CollectorRunReport
  let failure: Error | null = null
  try {
    const attribution = await createAttributionEncoder({
      enabled: config.attributionEnabled,
      secretFile: config.attributionSecretFile,
    })
    const authorities = await client.registerDevice(
      config.deviceId, config.deviceName, selected === 'native' ? NATIVE_PROVIDERS : [],
      config.machine,
    )
    registered = true
    await flushTelemetry(outboxPath)
    console.log(`  claude/codex source: ${selected} (mode=${CLAUDE_CODEX_SOURCE})`)
    const sources = selected === 'cc-switch'
      ? await runLegacyMode(attribution)
      : await runNativeMode(authorities, attribution)
    logSourceReports(sources)
    report = buildCollectorRunReport(start, sources)
    if (report.status !== 'success') failure = new Error('one or more collector sources failed')
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    report = failedCollectorRunReport(start, failure)
  }
  return { report, registered, failure }
}

function applyAdaptiveOutcome(
  context: AdaptiveRunContext | null,
  report: CollectorRunReport,
  failure: Error | null,
): AdaptiveScheduleState | null {
  if (!context) return null
  const now = new Date(report.finished_at)
  const next = failure
    ? recordFailure(context.state, now)
    : recordSuccess(context.state, {
      activityObserved: context.activityObserved,
      emitted: report.emitted,
    }, now)
  next.probe = context.signatures
  report.schedule_interval_minutes = promisedIntervalMinutes(next)
  return next
}

async function deliverReport(
  report: CollectorRunReport,
  registered: boolean,
  outboxPath: string,
): Promise<void> {
  const queued = await queueReport(report, outboxPath)
  if (registered) {
    if (queued) await flushTelemetry(outboxPath)
    else {
      try { await client.reportRun(report) } catch { /* local warning already emitted */ }
    }
  }
}

async function main(): Promise<void> {
  assertCollectorTarget(config)
  console.log(`[Tokember collector] device=${config.deviceName} (${config.deviceId})`)
  console.log(`[Tokember collector] server=${config.serverUrl}`)
  const selected = CLAUDE_CODEX_SOURCE === 'cc-switch' ? 'cc-switch' : 'native'
  const adaptive = await prepareAdaptiveRun(selected)
  if (!adaptive.run) return
  try {
    const start = startCollectorRun({
      device_id: config.deviceId,
      collector_kind: 'native',
      collector_version: config.collectorVersion,
      schedule_interval_minutes: config.scheduleIntervalMinutes,
    })
    const outboxPath = getObservabilityStatePath()
    const result = await executeCollector(selected, start, outboxPath)
    const nextState = applyAdaptiveOutcome(adaptive.context, result.report, result.failure)
    await deliverReport(result.report, result.registered, outboxPath)
    if (nextState) await saveAdaptiveState(nextState)
    if (result.failure) throw result.failure
    console.log(`Synced: ${result.report.accepted} changed records out of ${result.report.emitted} emitted`)
  } finally {
    await adaptive.context?.lock.release()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Collector failed: ${sanitizeCollectorError(error)}`)
    process.exit(1)
  })
}
