import { rmSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { getProjectAttribution } from '../src/attribution.ts'
import { initDB } from '../src/db.ts'
import { getMaintenanceSummary } from '../src/pricing.ts'
import { apiRoutes } from '../src/routes.ts'
import { buildAuthoritativeSourceFilter } from '../src/source-authority.ts'

const DB_PATH = '/tmp/tokember-tab-switch-benchmark.db'
const ROWS = Number(process.env.BENCH_ROWS ?? 10_000)
const REPEATS = Number(process.env.BENCH_REPEATS ?? 3)
const DEVICES = 8
const MODELS = 40
const PROJECTS = 80
const NOW = new Date('2026-07-18T12:00:00.000Z')
const START = Date.parse('2024-07-19T00:00:00.000Z')
const SPAN = NOW.getTime() - START

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

async function measure(
  operation: () => unknown | Promise<unknown>,
): Promise<{ median_ms: number; samples_ms: number[]; payload_bytes: number }> {
  await operation()
  const samples: number[] = []
  let value: unknown
  for (let index = 0; index < REPEATS; index += 1) {
    const started = performance.now()
    value = await operation()
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    median_ms: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2)),
    samples_ms: samples.map(sample => Number(sample.toFixed(2))),
    payload_bytes: payloadBytes(value),
  }
}

function insertDimensions(db: ReturnType<typeof initDB>): void {
  const device = db.prepare(`
    INSERT INTO devices (id, name, last_seen_at) VALUES (?, ?, ?)
  `)
  const group = db.prepare(`
    INSERT INTO attribution_project_groups (id, display_name) VALUES (?, ?)
  `)
  const project = db.prepare(`
    INSERT INTO attribution_projects
      (device_id, project_id, group_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (let index = 0; index < PROJECTS; index += 1) {
    group.run(index + 1, `Benchmark project ${index + 1}`)
  }
  for (let index = 0; index < DEVICES; index += 1) {
    const deviceId = `device-${index + 1}`
    device.run(deviceId, `Benchmark device ${index + 1}`, NOW.toISOString())
    for (let projectIndex = 0; projectIndex < PROJECTS; projectIndex += 1) {
      project.run(
        deviceId, `project-${projectIndex + 1}`, projectIndex + 1,
        new Date(START).toISOString(), NOW.toISOString(),
      )
    }
  }
}

function insertRules(db: ReturnType<typeof initDB>): void {
  const insert = db.prepare(`
    INSERT INTO pricing_rules
      (model, mode, input_price, output_price, cache_read_price, cache_write_price)
    VALUES (?, 'priced', 1.5, 6, 0.15, 1.5)
  `)
  db.transaction(() => {
    for (let index = 0; index < MODELS; index += 1) insert.run(`model-${index + 1}`)
  })()
}

function sourceFile(provider: string): string {
  if (provider === 'codex') return 'codex'
  if (provider === 'claude') return 'claude-code'
  return provider
}

function insertUsage(db: ReturnType<typeof initDB>): void {
  const providers = ['codex', 'claude', 'gemini', 'antigravity']
  const insert = db.prepare(`
    INSERT INTO usage_records (
      device_id, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, reasoning_tokens,
      cost_usd, timestamp, source_file, dedup_key, pricing_status,
      request_count, attribution_version, attribution_status, project_id, session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'captured', ?, ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < ROWS; index += 1) {
      const provider = providers[index % providers.length]!
      const unpriced = index % 5 === 0
      const dedup = provider === 'antigravity'
        ? `antigravity:benchmark:${index}` : `benchmark:${index}`
      insert.run(
        `device-${(index % DEVICES) + 1}`, provider, `model-${(index % MODELS) + 1}`,
        1_000 + index % 500, 300 + index % 100, index % 200, index % 50, index % 30,
        unpriced ? 0 : (index % 1000) / 100_000,
        new Date(START + Math.floor((index / ROWS) * SPAN)).toISOString(),
        sourceFile(provider), dedup, unpriced ? 'unpriced' : 'priced',
        (index % 3) + 1, `project-${(index % PROJECTS) + 1}`, `session-${index % 2_000}`,
      )
    }
  })()
}

function createFixture() {
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${DB_PATH}${suffix}`, { force: true })
  const db = initDB(DB_PATH)
  insertDimensions(db)
  insertRules(db)
  insertUsage(db)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('ANALYZE')
  return db
}

async function publicReads(db: ReturnType<typeof initDB>) {
  const app = apiRoutes(db, DB_PATH, { env: { NODE_ENV: 'test' } })
  const read = async (path: string) => {
    const response = await app.request(path)
    if (!response.ok) throw new Error(`${path} returned ${response.status}`)
    return response.json()
  }
  return {
    stats_30d: await measure(() => read('/stats?days=30&timezone_offset=0')),
    stats_all: await measure(() => read('/stats?days=0&timezone_offset=0')),
    stats_year: await measure(() => read(
      '/stats/year?year=2026&since=2026-01-01T00%3A00%3A00.000Z'
      + '&until=2027-01-01T00%3A00%3A00.000Z&timezone_offset=0',
    )),
  }
}

function authorityPlan(db: ReturnType<typeof initDB>): string[] {
  const authority = buildAuthoritativeSourceFilter('', ROWS)
  return db.prepare(`EXPLAIN QUERY PLAN
    SELECT SUM(request_count) FROM usage_records
    WHERE timestamp >= ? AND timestamp < ? AND id <= ? AND ${authority}
  `).all('2024-07-19T00:00:00.000Z', NOW.toISOString(), ROWS)
    .map(row => String((row as { detail: string }).detail))
}

function maintenanceStatements(): number {
  let statements = 0
  const traced = new Database(DB_PATH, {
    readonly: true,
    verbose: () => { statements += 1 },
  })
  getMaintenanceSummary(traced)
  traced.close()
  return statements
}

async function main(): Promise<void> {
  const fixtureStarted = performance.now()
  const db = createFixture()
  const fixtureMs = performance.now() - fixtureStarted
  const publicResults = await publicReads(db)
  const attribution = await measure(() => getProjectAttribution(db))
  const maintenance = await measure(() => getMaintenanceSummary(db))
  const plan = authorityPlan(db)
  db.close()
  console.log(JSON.stringify({
    dataset: {
      rows: ROWS, devices: DEVICES, providers: 4, models: MODELS, projects: PROJECTS,
      unpriced_rows: Math.ceil(ROWS / 5), database_bytes: statSync(DB_PATH).size,
      fixture_build_ms: Number(fixtureMs.toFixed(2)), repeats: REPEATS,
    },
    public_reads: publicResults,
    project_attribution: attribution,
    maintenance_summary: { ...maintenance, sql_statements: maintenanceStatements() },
    authority_plan: plan,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
