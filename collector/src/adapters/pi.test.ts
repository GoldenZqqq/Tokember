import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { emptyIncrementalSourceState } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import { CollectionObserver } from './types.js'
import { collectOmp, collectPi } from './pi.js'

function sessionLine(id: string, ts: string): string {
  return JSON.stringify({ type: 'session', id, timestamp: ts, cwd: '/tmp/demo' })
}

function assistantLine(options: {
  id: string
  model: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
  responseId?: string
  timestamp: string | number
}): string {
  return JSON.stringify({
    type: 'message',
    id: options.id,
    timestamp: options.timestamp,
    message: {
      role: 'assistant',
      model: options.model,
      responseId: options.responseId,
      usage: {
        input: options.input,
        output: options.output,
        cacheRead: options.cacheRead ?? 0,
        cacheWrite: options.cacheWrite ?? 0,
        ...(options.cost != null ? { cost: { total: options.cost } } : {}),
      },
    },
  })
}

test('Pi fixture emits assistant usage with stable dedup and session attribution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-pi-'))
  const previous = process.env.PI_AGENT_SESSIONS_DIR
  process.env.PI_AGENT_SESSIONS_DIR = root
  try {
    const project = join(root, '--tmp-demo--')
    await mkdir(project, { recursive: true })
    const file = join(project, '2026-07-21T10-00-00_session-a.jsonl')
    await writeFile(file, [
      sessionLine('sess-a', '2026-07-21T10:00:00.000Z'),
      JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-07-21T10:00:01.000Z', message: { role: 'user', content: 'secret prompt' } }),
      assistantLine({
        id: 'a1', model: 'gpt-5.4', input: 100, output: 20, cacheRead: 10,
        cost: 0.012, responseId: 'resp-1', timestamp: '2026-07-21T10:00:02.000Z',
      }),
      assistantLine({
        id: 'a2', model: 'gpt-5.4', input: 0, output: 0, timestamp: '2026-07-21T10:00:03.000Z',
      }),
      '',
    ].join('\n'), 'utf8')

    const records = await collectPi()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.provider, 'pi')
    assert.equal(records[0]?.model, 'gpt-5.4')
    assert.equal(records[0]?.input_tokens, 100)
    assert.equal(records[0]?.output_tokens, 20)
    assert.equal(records[0]?.cache_read_tokens, 10)
    assert.equal(records[0]?.cost_usd, 0.012)
    assert.equal(records[0]?.cost_provided, true)
    assert.equal(records[0]?.dedup_key, 'pi:sess-a:resp-1')
    assert.equal(records[0]?.attribution?.status, 'captured')
    assert.equal(records[0]?.source_file, 'pi')
    assert.ok(!JSON.stringify(records).includes('secret prompt'))
  } finally {
    if (previous == null) delete process.env.PI_AGENT_SESSIONS_DIR
    else process.env.PI_AGENT_SESSIONS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi incremental collect only scans new JSONL bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-pi-inc-'))
  const previous = process.env.PI_AGENT_SESSIONS_DIR
  process.env.PI_AGENT_SESSIONS_DIR = root
  try {
    const project = join(root, '--proj--')
    await mkdir(project, { recursive: true })
    const file = join(project, 'session.jsonl')
    await writeFile(file, [
      sessionLine('s1', '2026-07-21T11:00:00.000Z'),
      assistantLine({
        id: 'a1', model: 'm', input: 5, output: 1, responseId: 'r1',
        timestamp: '2026-07-21T11:00:01.000Z',
      }),
      '',
    ].join('\n'), 'utf8')

    const state = emptyIncrementalSourceState()
    const firstCursor = new IncrementalCursor(state)
    const firstObserver = new CollectionObserver()
    const first = await collectPi(undefined, firstObserver, firstCursor)
    assert.equal(first.length, 1)
    assert.equal(firstObserver.snapshot().scanned, 1)

    const secondCursor = new IncrementalCursor(firstCursor.snapshot())
    const secondObserver = new CollectionObserver()
    const second = await collectPi(undefined, secondObserver, secondCursor)
    assert.equal(second.length, 0)
    assert.equal(secondObserver.snapshot().scanned, 0)

    await appendFile(file, assistantLine({
      id: 'a2', model: 'm', input: 7, output: 2, responseId: 'r2',
      timestamp: '2026-07-21T11:00:05.000Z',
    }) + '\n', 'utf8')

    const thirdCursor = new IncrementalCursor(secondCursor.snapshot())
    const thirdObserver = new CollectionObserver()
    const third = await collectPi(undefined, thirdObserver, thirdCursor)
    assert.equal(third.length, 1)
    assert.equal(third[0]?.dedup_key, 'pi:s1:r2')
    assert.equal(thirdObserver.snapshot().scanned, 1)
    assert.equal(third[0]?.attribution?.status, 'captured')
  } finally {
    if (previous == null) delete process.env.PI_AGENT_SESSIONS_DIR
    else process.env.PI_AGENT_SESSIONS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('OMP shares the Pi parser against ~/.omp sessions root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-omp-'))
  const previous = process.env.OMP_SESSIONS_DIR
  process.env.OMP_SESSIONS_DIR = root
  try {
    const project = join(root, '--x--')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 's.jsonl'), [
      sessionLine('omp-1', '2026-07-21T12:00:00.000Z'),
      assistantLine({
        id: 'a1', model: 'claude-sonnet', input: 3, output: 1, responseId: 'x',
        timestamp: '2026-07-21T12:00:01.000Z',
      }),
      '',
    ].join('\n'), 'utf8')

    const records = await collectOmp()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.provider, 'omp')
    assert.equal(records[0]?.dedup_key, 'omp:omp-1:x')
    assert.match(records[0]?.timestamp ?? '', /^2026-07-21/)
  } finally {
    if (previous == null) delete process.env.OMP_SESSIONS_DIR
    else process.env.OMP_SESSIONS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('missing Pi install returns empty without throwing', async () => {
  const previous = process.env.PI_AGENT_SESSIONS_DIR
  process.env.PI_AGENT_SESSIONS_DIR = join(tmpdir(), `tokember-pi-missing-${Date.now()}`)
  try {
    const records = await collectPi()
    assert.deepEqual(records, [])
  } finally {
    if (previous == null) delete process.env.PI_AGENT_SESSIONS_DIR
    else process.env.PI_AGENT_SESSIONS_DIR = previous
  }
})
