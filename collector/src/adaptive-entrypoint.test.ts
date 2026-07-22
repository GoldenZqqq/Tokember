import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const ENV_KEYS = [
  'TOKEMBER_SERVER',
  'TOKEMBER_DEVICE_TOKEN',
  'TOKEMBER_DEVICE_ID',
  'TOKEMBER_SCHEDULE_MODE',
  'TOKEMBER_ADAPTIVE_STATE',
  'TOKEMBER_COLLECTOR_STATE',
  'TOKEMBER_OBSERVABILITY_STATE',
  'TOKEMBER_CLAUDE_CODEX_SOURCE',
] as const

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

test('adaptive entrypoint skip performs no network or observability writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-admission-'))
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  const adaptivePath = join(root, 'adaptive-schedule.json')
  const collectorPath = join(root, 'collector-state.json')
  const outboxPath = join(root, 'collector-runs.json')
  t.after(async () => {
    restoreEnvironment(previous)
    await rm(root, { recursive: true, force: true })
  })
  Object.assign(process.env, {
    TOKEMBER_SERVER: 'http://127.0.0.1:1',
    TOKEMBER_DEVICE_TOKEN: 'unused-on-skip',
    TOKEMBER_DEVICE_ID: 'adaptive-skip-test',
    TOKEMBER_SCHEDULE_MODE: 'adaptive',
    TOKEMBER_ADAPTIVE_STATE: adaptivePath,
    TOKEMBER_COLLECTOR_STATE: collectorPath,
    TOKEMBER_OBSERVABILITY_STATE: outboxPath,
    TOKEMBER_CLAUDE_CODEX_SOURCE: 'native',
  })
  await writeFile(adaptivePath, JSON.stringify({
    version: 1,
    band: 'idle',
    next_eligible_at: '2099-01-01T00:00:00.000Z',
    last_activity_at: null,
    last_completed_at: '2026-07-21T00:00:00.000Z',
    consecutive_empty: 8,
    consecutive_failures: 0,
    probe: {},
  }), 'utf8')

  const { prepareAdaptiveRun } = await import('./index.js')
  const result = await prepareAdaptiveRun('native')

  assert.deepEqual(result, { run: false, context: null })
  assert.equal(await missing(outboxPath), true)
  assert.equal(await missing(`${adaptivePath}.lock`), true)
  const saved = JSON.parse(await readFile(adaptivePath, 'utf8')) as { probe: object }
  assert.ok(Object.keys(saved.probe).length > 0)
})
