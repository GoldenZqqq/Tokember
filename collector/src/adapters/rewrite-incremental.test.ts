import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { emptyIncrementalSourceState, type IncrementalSourceState } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import { collectExtension } from './cline-roo.js'
import { collectGemini } from './gemini.js'
import { CollectionObserver, type UsageRecord } from './types.js'

interface RewriteRun {
  records: UsageRecord[]
  state: IncrementalSourceState
  scanned: number
}

async function runGemini(state: IncrementalSourceState): Promise<RewriteRun> {
  const cursor = new IncrementalCursor(state)
  const observer = new CollectionObserver()
  const records = await collectGemini(observer, cursor)
  return { records, state: cursor.snapshot(), scanned: observer.snapshot().scanned }
}

async function runExtension(
  state: IncrementalSourceState,
  storage: string,
  provider: string,
): Promise<RewriteRun> {
  const cursor = new IncrementalCursor(state)
  const observer = new CollectionObserver()
  const records = await collectExtension({
    extensionId: 'fixture', provider, observer, incremental: cursor,
    storageDirs: [storage],
  })
  return { records, state: cursor.snapshot(), scanned: observer.snapshot().scanned }
}

function geminiSession(id: string) {
  return {
    sessionId: 'session-1', startTime: '2026-07-17T00:00:00.000Z',
    messages: [{
      id, timestamp: '2026-07-17T00:01:00.000Z',
      type: 'gemini', model: 'gemini-test',
      tokens: { input: 5, output: 2, cached: 1, thoughts: 1 },
    }],
  }
}

function uiMessages() {
  return [{
    type: 'say', say: 'api_req_started', ts: Date.parse('2026-07-17T00:00:00.000Z'),
    text: JSON.stringify({ tokensIn: 5, tokensOut: 2, cost: 0.01 }),
  }]
}

function history(model: string) {
  return [{ role: 'user', content: [{ text: `<model>vendor/${model}</model>` }] }]
}

test('Gemini skips two unchanged runs and keeps malformed files retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-gemini-rewrite-'))
  const previous = process.env.GEMINI_TMP_DIR
  process.env.GEMINI_TMP_DIR = root
  const chats = join(root, 'project', 'chats')
  const file = join(chats, 'session-one.json')
  try {
    await mkdir(chats, { recursive: true })
    await writeFile(file, JSON.stringify(geminiSession('first')))
    const first = await runGemini(emptyIncrementalSourceState())
    const emptyOne = await runGemini(first.state)
    const emptyTwo = await runGemini(emptyOne.state)
    assert.deepEqual([emptyOne.scanned, emptyTwo.scanned], [0, 0])
    await writeFile(file, '{malformed')
    const malformed = await runGemini(emptyTwo.state)
    const retried = await runGemini(malformed.state)
    assert.deepEqual([malformed.scanned, retried.scanned], [1, 1])
    await writeFile(file, JSON.stringify(geminiSession('recovered-longer')))
    const recovered = await runGemini(retried.state)
    assert.deepEqual(recovered.records.map(row => row.dedup_key), [
      'gemini:session-1:recovered-longer',
    ])
  } finally {
    if (previous == null) delete process.env.GEMINI_TMP_DIR
    else process.env.GEMINI_TMP_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

for (const provider of ['cline', 'roo-code']) {
  test(`${provider} composite signature notices model-history rewrites`, async () => {
    const root = await mkdtemp(join(tmpdir(), `tokember-${provider}-rewrite-`))
    const task = join(root, 'tasks', 'task-1')
    const ui = join(task, 'ui_messages.json')
    const model = join(task, 'api_conversation_history.json')
    try {
      await mkdir(task, { recursive: true })
      await writeFile(ui, JSON.stringify(uiMessages()))
      await writeFile(model, JSON.stringify(history('model-one')))
      const first = await runExtension(emptyIncrementalSourceState(), root, provider)
      const empty = await runExtension(first.state, root, provider)
      assert.equal(empty.scanned, 0)
      await writeFile(model, JSON.stringify(history('model-two-longer')))
      const future = new Date(Date.now() + 5_000)
      await utimes(model, future, future)
      const changed = await runExtension(empty.state, root, provider)
      assert.equal(changed.records[0]?.model, 'model-two-longer')
      const emptyAgain = await runExtension(changed.state, root, provider)
      assert.equal(emptyAgain.scanned, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
