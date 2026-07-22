import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { readJsonlTail } from './jsonl-tail.js'

test('tail reader advances only through complete LF and CRLF lines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-jsonl-tail-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"one":1}\r\n{"two":', 'utf-8')
    const first = await readJsonlTail(path)
    assert.deepEqual(first.lines, ['{"one":1}'])
    assert.equal(first.safe_offset_bytes, Buffer.byteLength('{"one":1}\r\n'))
    assert.ok(first.trailing_bytes > 0)

    await appendFile(path, '2}\n', 'utf-8')
    const second = await readJsonlTail(path, first.safe_offset_bytes)
    assert.deepEqual(second.lines, ['{"two":2}'])
    assert.equal(second.trailing_bytes, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('large JSONL append reads only the delta after a confirmed offset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-jsonl-large-'))
  const path = join(directory, 'events.jsonl')
  const prefix = `${JSON.stringify({ payload: 'x'.repeat(1_024) })}\n`.repeat(1_024)
  const delta = `${JSON.stringify({ payload: 'delta' })}\n`
  try {
    await writeFile(path, prefix, 'utf-8')
    const first = await readJsonlTail(path)
    assert.equal(first.bytes_read, Buffer.byteLength(prefix))
    assert.equal(first.safe_offset_bytes, first.bytes_read)

    await appendFile(path, delta, 'utf-8')
    const second = await readJsonlTail(path, first.safe_offset_bytes)
    assert.deepEqual(second.lines, [JSON.stringify({ payload: 'delta' })])
    assert.equal(second.bytes_read, Buffer.byteLength(delta))
    assert.ok(second.bytes_read < first.bytes_read / 1_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tail reader rejects invalid offsets before opening the file', async () => {
  await assert.rejects(readJsonlTail('unused', -1), /offset/)
  await assert.rejects(readJsonlTail('unused', 1.5), /offset/)
})
