import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { emptyIncrementalSourceState, type IncrementalSourceState } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import { collectCursor } from './cursor.js'
import { CollectionObserver } from './types.js'

function bubble(input: number, output: number, createdAt: number) {
  return JSON.stringify({
    tokenCount: { inputTokens: input, outputTokens: output },
    modelInfo: { modelName: 'cursor-test' },
    createdAt,
  })
}

function mutateDatabase(path: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
    mutate(db)
  } finally {
    db.close()
  }
}

async function runCursor(state: IncrementalSourceState) {
  const cursor = new IncrementalCursor(state)
  const observer = new CollectionObserver()
  const records = await collectCursor(observer, cursor)
  return {
    records,
    state: cursor.snapshot(),
    scanned: observer.snapshot().scanned,
  }
}

test('Cursor skips unchanged DB signatures and overlaps rowid updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-cursor-incremental-'))
  const path = join(root, 'state.vscdb')
  const previous = process.env.CURSOR_DB
  process.env.CURSOR_DB = path
  try {
    mutateDatabase(path, db => db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    ).run('bubbleId:c1:b1', bubble(1, 2, Date.parse('2026-07-17T00:00:00.000Z'))))
    const first = await runCursor(emptyIncrementalSourceState())
    const emptyOne = await runCursor(first.state)
    const emptyTwo = await runCursor(emptyOne.state)
    assert.equal(first.records.length, 1)
    assert.deepEqual([emptyOne.scanned, emptyTwo.scanned], [0, 0])

    mutateDatabase(path, db => db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    ).run('bubbleId:c1:b2', bubble(3, 4, Date.parse('2026-07-17T00:01:00.000Z'))))
    const appended = await runCursor(emptyTwo.state)
    assert.deepEqual(appended.records.map(row => row.dedup_key), [
      'cursor:bubbleId:c1:b1', 'cursor:bubbleId:c1:b2',
    ])
    const emptyAfterAppend = await runCursor(appended.state)
    assert.equal(emptyAfterAppend.scanned, 0)

    mutateDatabase(path, db => db.prepare(
      'UPDATE cursorDiskKV SET value = ? WHERE key = ?',
    ).run(bubble(9, 2, Date.parse('2026-07-17T00:00:00.000Z')), 'bubbleId:c1:b1'))
    const future = new Date(Date.now() + 5_000)
    await utimes(path, future, future)
    const updated = await runCursor(emptyAfterAppend.state)
    assert.equal(updated.records.find(row => row.dedup_key.endsWith('b1'))?.input_tokens, 9)
  } finally {
    if (previous == null) delete process.env.CURSOR_DB
    else process.env.CURSOR_DB = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Cursor falls back safely when cursorDiskKV has no rowid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-cursor-no-rowid-'))
  const path = join(root, 'state.vscdb')
  const previous = process.env.CURSOR_DB
  process.env.CURSOR_DB = path
  try {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID')
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'bubbleId:no-rowid:b1', bubble(2, 3, Date.parse('2026-07-17T00:00:00.000Z')),
    )
    db.close()
    const first = await runCursor(emptyIncrementalSourceState())
    assert.equal(first.records[0]?.dedup_key, 'cursor:bubbleId:no-rowid:b1')
    assert.equal(first.state.values.rowid_supported, false)
    const empty = await runCursor(first.state)
    assert.deepEqual([empty.records.length, empty.scanned], [0, 0])
  } finally {
    if (previous == null) delete process.env.CURSOR_DB
    else process.env.CURSOR_DB = previous
    await rm(root, { recursive: true, force: true })
  }
})
