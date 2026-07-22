import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { emptyAdaptiveState } from './adaptive-policy.js'
import {
  acquireAdaptiveLock,
  decodeAdaptiveState,
  loadAdaptiveState,
  saveAdaptiveState,
  UnsupportedAdaptiveStateVersionError,
} from './adaptive-state.js'

test('adaptive state round-trips atomically without local paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-adaptive-state-'))
  const path = join(directory, 'state.json')
  try {
    const state = {
      ...emptyAdaptiveState(new Date('2026-01-01T00:00:00.000Z')),
      probe: { codex: 'a'.repeat(64) },
    }
    await saveAdaptiveState(state, path)
    assert.deepEqual(await loadAdaptiveState(path), state)
    assert.doesNotMatch(await readFile(path, 'utf-8'), /Users|home|session/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing or malformed adaptive state becomes immediately due', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-adaptive-recover-'))
  const path = join(directory, 'state.json')
  const now = new Date('2026-01-01T00:00:00.000Z')
  const warnings: string[] = []
  try {
    assert.equal((await loadAdaptiveState(path, now)).next_eligible_at, now.toISOString())
    await writeFile(path, '{"version":1,"band":"idle"}', 'utf-8')
    assert.equal((await loadAdaptiveState(path, now, value => warnings.push(value))).band, 'active')
    assert.deepEqual(warnings, ['Adaptive schedule state is invalid; collection is due now'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('future adaptive state refuses overwrite and probe entries stay bounded', () => {
  assert.throws(() => decodeAdaptiveState({ version: 2 }), UnsupportedAdaptiveStateVersionError)
  assert.throws(() => decodeAdaptiveState({
    ...emptyAdaptiveState(), probe: { codex: 'C:\\Users\\Alice\\session.json' },
  }), /probe entry is invalid/)
})

test('adaptive lock rejects overlap, releases cleanly and reclaims stale files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-adaptive-lock-'))
  const path = join(directory, 'state.lock')
  try {
    const first = await acquireAdaptiveLock(path)
    assert.ok(first)
    assert.equal(await acquireAdaptiveLock(path), null)
    await first.release()
    const second = await acquireAdaptiveLock(path)
    assert.ok(second)
    await second.release()
    await writeFile(path, 'old', 'utf-8')
    const old = new Date(Date.now() - 16 * 60_000)
    await utimes(path, old, old)
    const reclaimed = await acquireAdaptiveLock(path)
    assert.ok(reclaimed)
    await reclaimed.release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('adaptive lock creates missing parent directory for new brand path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-adaptive-parent-'))
  const nested = join(root, '.tokember', 'adaptive-schedule.json.lock')
  try {
    const lock = await acquireAdaptiveLock(nested)
    assert.ok(lock)
    await lock.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
