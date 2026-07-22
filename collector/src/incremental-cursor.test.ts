import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'

import {
  HOT_DIRECTORY_LIMIT,
  HOT_FILE_LIMIT,
  RECONCILE_INTERVAL_MS,
  emptyIncrementalSourceState,
} from './collector-state.js'
import { IncrementalCursor } from './incremental-cursor.js'

function stagedCursor(fileCount: number, directoryCount = 0): IncrementalCursor {
  const cursor = new IncrementalCursor()
  for (let index = 0; index < fileCount; index++) {
    cursor.stageFile(`file-${index}`, {
      path: `C:\\logs\\file-${index}.jsonl`, mtime_ms: index,
      size_bytes: index + 1, offset_bytes: index + 1, metadata: {},
    })
  }
  for (let index = 0; index < directoryCount; index++) {
    cursor.stageDirectory(`dir-${index}`, {
      path: `C:\\logs\\dir-${index}`, mtime_ms: index,
    })
  }
  return cursor
}

function reconciledHistory(coldCount: number): ReturnType<IncrementalCursor['snapshot']> {
  const cursor = new IncrementalCursor()
  for (let index = 0; index < coldCount; index++) {
    cursor.stageFile(`cold-${index}`, {
      path: `C:\\cold\\${index}.jsonl`, mtime_ms: index,
      size_bytes: 1, offset_bytes: 1, metadata: {},
    })
  }
  for (let index = 0; index < HOT_FILE_LIMIT; index++) {
    cursor.stageFile(`active-${index}`, {
      path: `C:\\active\\${index}.jsonl`, mtime_ms: coldCount + index,
      size_bytes: 1, offset_bytes: 1, metadata: {},
    })
  }
  return cursor.snapshot()
}

test('hot inventories stay bounded after large reconciliation histories', () => {
  const medium = stagedCursor(100, 100).snapshot()
  const large = stagedCursor(10_000, 10_000).snapshot()

  assert.equal(Object.keys(medium.files).length, 100)
  assert.equal(Object.keys(large.files).length, HOT_FILE_LIMIT)
  assert.equal(Object.keys(medium.directories).length, HOT_DIRECTORY_LIMIT)
  assert.equal(Object.keys(large.directories).length, HOT_DIRECTORY_LIMIT)
  assert.equal(new IncrementalCursor(large).hotFileEntries().length, HOT_FILE_LIMIT)
  assert.ok(JSON.stringify(large).length < 80_000)
})

test('100 and 10,000 cold histories have the same deterministic fast-path inventory', () => {
  const medium = reconciledHistory(100)
  const large = reconciledHistory(10_000)
  assert.deepEqual(medium.hot_files, large.hot_files)
  assert.equal(new IncrementalCursor(medium).hotFileEntries().length, HOT_FILE_LIMIT)
  assert.equal(new IncrementalCursor(large).hotFileEntries().length, HOT_FILE_LIMIT)

  const measure = (state: typeof medium) => {
    const started = performance.now()
    for (let index = 0; index < 500; index++) {
      new IncrementalCursor(state).hotFileEntries()
    }
    return performance.now() - started
  }
  console.log(`  incremental fast-path smoke: 100=${measure(medium).toFixed(1)}ms 10000=${measure(large).toFixed(1)}ms`)
})

test('file plans distinguish unchanged append and replay safely', () => {
  const cursor = stagedCursor(1)
  const file = cursor.hotFileEntries()[0]
  assert.equal(cursor.filePlan(file[0], { mtime_ms: 0, size_bytes: 1 }), 'unchanged')
  assert.equal(cursor.filePlan(file[0], { mtime_ms: 2, size_bytes: 2 }), 'append')
  assert.equal(cursor.filePlan(file[0], { mtime_ms: 2, size_bytes: 2 }, ['model']), 'replay')
  assert.equal(cursor.filePlan(file[0], { mtime_ms: 2, size_bytes: 0 }), 'replay')
  assert.equal(cursor.filePlan('new', { mtime_ms: 2, size_bytes: 2 }), 'replay')

  cursor.stageFile('partial', {
    path: 'partial.jsonl', mtime_ms: 3, size_bytes: 10,
    offset_bytes: 5, metadata: {},
  })
  assert.equal(cursor.filePlan('partial', { mtime_ms: 3, size_bytes: 10 }), 'append')
})

test('reconciliation and cold-file decisions use the confirmed boundary', () => {
  const state = emptyIncrementalSourceState()
  state.last_reconciled_at = '2026-07-17T00:00:00.000Z'
  const cursor = new IncrementalCursor(state)
  const boundary = Date.parse(state.last_reconciled_at)

  assert.equal(cursor.needsReconciliation(boundary + RECONCILE_INTERVAL_MS - 1), false)
  assert.equal(cursor.needsReconciliation(boundary + RECONCILE_INTERVAL_MS), true)
  assert.equal(cursor.coldFileNeedsScan(boundary), true)
  assert.equal(cursor.coldFileNeedsScan(boundary + 1), true)
})

test('cursor snapshots do not mutate their confirmed input', () => {
  const previous = stagedCursor(2).snapshot()
  const cursor = new IncrementalCursor(previous)
  cursor.removeFile('file-1')
  cursor.setValue('rowid', 42)
  cursor.finishReconciliation(new Date('2026-07-17T01:00:00.000Z'))

  assert.ok('file-1' in previous.files)
  assert.equal(previous.values.rowid, undefined)
  assert.equal(cursor.snapshot().values.rowid, 42)
})

test('v1 bootstrap cutoff remains stable while the first candidate is built', () => {
  const cursor = new IncrementalCursor(
    emptyIncrementalSourceState(), '2026-07-17T00:00:00.000Z',
  )
  cursor.stageDirectory('root', { path: 'C:\\logs', mtime_ms: 1 })

  assert.equal(cursor.isUninitialized(), true)
  assert.equal(cursor.shouldBootstrapAtEnd(Date.parse('2026-07-16T23:59:59.000Z')), true)
  assert.equal(cursor.shouldBootstrapAtEnd(Date.parse('2026-07-17T00:00:00.000Z')), false)
})

test('cursor rejects unbounded scalar state before persistence', () => {
  const cursor = new IncrementalCursor()
  assert.throws(() => cursor.setValue('model', 'x'.repeat(2_049)), /bounded/)
  assert.throws(() => cursor.stageFile('file', {
    path: 'file.jsonl', mtime_ms: 1, size_bytes: 1, offset_bytes: 1,
    metadata: { model: 'x'.repeat(2_049) },
  }), /bounded/)
  assert.equal(cursor.hotFileEntries().length, 0)
})
