import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import {
  advanceCheckpoint,
  buildCollectionWindow,
  emptyCollectorState,
  emptyIncrementalSourceState,
  getCollectorStatePath,
  getCheckpoint,
  getIncrementalSourceState,
  loadCollectorState,
  saveCollectorState,
  setIncrementalSourceState,
  UnsupportedCollectorStateVersionError,
} from './collector-state.js'

test('Tokember collector state path takes precedence over the legacy alias', () => {
  assert.equal(getCollectorStatePath({
    TOKEMBER_COLLECTOR_STATE: 'tokember-state.json',
    AI_BURN_COLLECTOR_STATE: 'legacy-state.json',
  }), 'tokember-state.json')
  assert.equal(getCollectorStatePath({
    AI_BURN_COLLECTOR_STATE: 'legacy-state.json',
  }), 'legacy-state.json')
})

test('default collector state path prefers ~/.tokember over a bare home', () => {
  const path = getCollectorStatePath({})
  assert.match(path.replace(/\\/g, '/'), /\/\.tokember\/collector-state\.json$|\/\.ai-burn\/collector-state\.json$/)
})

test('collection window never crosses the cutover and overlaps checkpoints', () => {
  const until = '2026-07-15T12:30:00.000Z'
  assert.deepEqual(buildCollectionWindow(
    until, {
      cutoverAt: '2026-07-15T12:00:00.000Z',
      checkpoint: '2026-07-15T12:10:00.000Z',
    },
  ), { since: '2026-07-15T12:05:00.000Z', until })
  assert.deepEqual(buildCollectionWindow(
    until, {
      cutoverAt: '2026-07-15T12:00:00.000Z',
      checkpoint: '2026-07-15T11:00:00.000Z',
    },
  ), { since: '2026-07-15T12:00:00.000Z', until })
})

test('state v2 round-trips provider and bounded source cursors atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-state-v2-'))
  const path = join(directory, 'state.json')
  try {
    const state = emptyCollectorState()
    advanceCheckpoint(state, {
      deviceId: 'device-1', provider: 'claude',
      checkpoint: '2026-07-15T12:00:00.000Z',
    })
    const source = emptyIncrementalSourceState()
    source.files.one = {
      path: 'C:\\logs\\one.jsonl', mtime_ms: 10, size_bytes: 20,
      offset_bytes: 20, metadata: { model: 'gpt-5' },
    }
    source.hot_files = ['one']
    source.values.rowid = 7
    source.last_reconciled_at = '2026-07-15T12:00:00.000Z'
    setIncrementalSourceState(state, {
      deviceId: 'device-1', source: 'codex', sourceState: source,
    })
    await saveCollectorState(state, path)

    const loaded = await loadCollectorState(path)
    assert.equal(loaded.version, 2)
    assert.equal(getCheckpoint(loaded, 'device-1', 'claude'), '2026-07-15T12:00:00.000Z')
    assert.deepEqual(getIncrementalSourceState(loaded, 'device-1', 'codex'), source)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('state v1 migrates without losing checkpoints and preserves one rollback backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-state-v1-'))
  const path = join(directory, 'state.json')
  const legacy = {
    version: 1,
    devices: { d1: { providers: { claude: { checkpoint: '2026-07-15T12:00:00.000Z' } } } },
  }
  try {
    await writeFile(path, JSON.stringify(legacy), 'utf-8')
    const migrated = await loadCollectorState(path)
    assert.equal(migrated.version, 2)
    assert.equal(getCheckpoint(migrated, 'd1', 'claude'), '2026-07-15T12:00:00.000Z')
    assert.deepEqual(getIncrementalSourceState(migrated, 'd1', 'claude'), emptyIncrementalSourceState())
    await saveCollectorState(migrated, path)
    assert.deepEqual(JSON.parse(await readFile(`${path}.v1.bak`, 'utf-8')), legacy)
    await saveCollectorState(migrated, path)
    assert.deepEqual(JSON.parse(await readFile(`${path}.v1.bak`, 'utf-8')), legacy)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid state warns and recovers while future versions refuse overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-state-invalid-'))
  const path = join(directory, 'state.json')
  try {
    const warnings: string[] = []
    await writeFile(path, '{broken', 'utf-8')
    assert.deepEqual(await loadCollectorState(path, warning => warnings.push(warning)), emptyCollectorState())
    assert.equal(warnings.length, 1)

    await writeFile(path, JSON.stringify({ version: 3, devices: {} }), 'utf-8')
    await assert.rejects(
      loadCollectorState(path, warning => warnings.push(warning)),
      UnsupportedCollectorStateVersionError,
    )
    assert.equal(warnings.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('malformed provider state is treated as having no checkpoint', () => {
  const malformed = {
    version: 2,
    devices: { d1: { providers: {}, sources: {} } },
  } as ReturnType<typeof emptyCollectorState>
  assert.equal(getCheckpoint(malformed, 'd1', 'claude'), undefined)
})
