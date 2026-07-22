import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, truncate, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { emptyIncrementalSourceState } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import {
  commitIncrementalJsonl,
  prepareIncrementalJsonl,
} from './incremental-jsonl.js'

test('confirmed JSONL cursors skip empty runs and read only appended bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-incremental-jsonl-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"one":1}\n', 'utf-8')
    const firstCursor = new IncrementalCursor()
    const first = await prepareIncrementalJsonl(path, firstCursor)
    assert.equal(first.kind, 'read')
    if (first.kind !== 'read') return
    commitIncrementalJsonl(firstCursor, first, { context: 'one' })

    const secondCursor = new IncrementalCursor(firstCursor.snapshot())
    assert.equal((await prepareIncrementalJsonl(path, secondCursor)).kind, 'unchanged')
    await appendFile(path, '{"two":2}\n', 'utf-8')
    const appended = await prepareIncrementalJsonl(path, secondCursor, {
      required_metadata: ['context'],
    })
    assert.equal(appended.kind, 'read')
    if (appended.kind !== 'read') return
    assert.deepEqual(appended.tail.lines, ['{"two":2}'])
    assert.equal(appended.start_offset_bytes, Buffer.byteLength('{"one":1}\n'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('truncated JSONL safely replays from byte zero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-jsonl-truncate-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"one":1}\n{"two":2}\n', 'utf-8')
    const firstCursor = new IncrementalCursor()
    const first = await prepareIncrementalJsonl(path, firstCursor)
    assert.equal(first.kind, 'read')
    if (first.kind !== 'read') return
    commitIncrementalJsonl(firstCursor, first)
    await truncate(path, Buffer.byteLength('{"one":1}\n'))

    const replay = await prepareIncrementalJsonl(path, new IncrementalCursor(firstCursor.snapshot()))
    assert.equal(replay.kind, 'read')
    if (replay.kind !== 'read') return
    assert.equal(replay.start_offset_bytes, 0)
    assert.deepEqual(replay.tail.lines, ['{"one":1}'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('v1 bootstrap can seed cold files but missing parser metadata forces later replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-jsonl-bootstrap-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"old":1}\n', 'utf-8')
    const future = new Date(Date.now() + 60_000).toISOString()
    const bootstrap = new IncrementalCursor(emptyIncrementalSourceState(), future)
    assert.equal((await prepareIncrementalJsonl(path, bootstrap)).kind, 'bootstrap')
    await appendFile(path, '{"new":2}\n', 'utf-8')

    const replay = await prepareIncrementalJsonl(
      path,
      new IncrementalCursor(bootstrap.snapshot()),
      { required_metadata: ['session_id'] },
    )
    assert.equal(replay.kind, 'read')
    if (replay.kind !== 'read') return
    assert.equal(replay.start_offset_bytes, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('full reconciliation skips unknown files older than its confirmed boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-jsonl-cold-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"old":1}\n', 'utf-8')
    const state = emptyIncrementalSourceState()
    state.last_reconciled_at = new Date(Date.now() + 60_000).toISOString()
    const result = await prepareIncrementalJsonl(
      path, new IncrementalCursor(state), { reconciling: true },
    )
    assert.equal(result.kind, 'cold')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
