import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { emptyIncrementalSourceState, type IncrementalSourceState } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import { CollectionObserver, type CollectionWindow, type UsageRecord } from './types.js'
import { collectClaude } from './claude.js'
import { collectCodex } from './codex.js'
import { collectGrok } from './grok.js'
import { incrementalFileKey } from './incremental-jsonl.js'

interface IncrementalRun {
  records: UsageRecord[]
  state: IncrementalSourceState
  scanned: number
}

async function runClaude(state: IncrementalSourceState): Promise<IncrementalRun> {
  const cursor = new IncrementalCursor(state)
  const observer = new CollectionObserver()
  const records = await collectClaude(undefined, observer, cursor)
  return { records, state: cursor.snapshot(), scanned: observer.snapshot().scanned }
}

async function runAdapter(
  adapter: typeof collectCodex,
  state: IncrementalSourceState,
  window?: CollectionWindow,
): Promise<IncrementalRun> {
  const cursor = new IncrementalCursor(state)
  const observer = new CollectionObserver()
  const records = await adapter(window, observer, cursor)
  return { records, state: cursor.snapshot(), scanned: observer.snapshot().scanned }
}

function claudeLine(id: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant', timestamp,
    message: {
      id, model: 'claude-test',
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  })
}

function codexToken(timestamp: string, total: number): string {
  return JSON.stringify({
    type: 'event_msg', timestamp,
    payload: { type: 'token_count', info: {
      last_token_usage: {
        input_tokens: 3, cached_input_tokens: 1,
        output_tokens: 1, reasoning_output_tokens: 2,
      },
      total_token_usage: {
        total_tokens: total, input_tokens: total - 1,
        output_tokens: 1, reasoning_output_tokens: 0,
      },
    } },
  })
}

function grokChunk(model: string): string {
  return JSON.stringify({
    method: 'session/update',
    params: { sessionId: 's1', update: {
      sessionUpdate: 'agent_message_chunk', _meta: { modelId: model },
    } },
  })
}

function grokTurn(promptId: string): string {
  return JSON.stringify({
    timestamp: 1_800_000_000,
    method: '_x.ai/session/update',
    params: { sessionId: 's1', update: {
      sessionUpdate: 'turn_completed', prompt_id: promptId,
      usage: { inputTokens: 5, outputTokens: 2 },
    } },
  })
}

test('Claude emits only appended complete messages after two empty runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-claude-incremental-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    const directory = join(root, 'projects', 'project')
    const file = join(directory, 'session.jsonl')
    await mkdir(directory, { recursive: true })
    await writeFile(file, `${claudeLine('first', '2026-07-17T00:00:00.000Z')}\n`)
    const first = await runClaude(emptyIncrementalSourceState())
    const emptyOne = await runClaude(first.state)
    const emptyTwo = await runClaude(emptyOne.state)
    assert.equal(first.records.length, 1)
    assert.deepEqual([emptyOne.scanned, emptyTwo.scanned], [0, 0])
    await appendFile(file, `${claudeLine('second', '2026-07-17T00:01:00.000Z')}\n`)
    const appended = await runClaude(emptyTwo.state)
    assert.deepEqual(appended.records.map(row => row.dedup_key), ['claude:second'])
  } finally {
    if (previous == null) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex tail state preserves model and cumulative context for old sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-codex-incremental-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = root
  try {
    const directory = join(root, 'sessions', '2020', '01', '01')
    const file = join(directory, 'rollout-old.jsonl')
    await mkdir(directory, { recursive: true })
    await writeFile(file, `${JSON.stringify({
      type: 'session_meta', payload: {
        session_id: 'old', model: 'gpt-old', cwd: 'C:\\work\\old-project',
      },
    })}\n${codexToken('2026-07-17T00:00:00.000Z', 7)}\n`)
    const first = await runAdapter(collectCodex, emptyIncrementalSourceState())
    const empty = await runAdapter(collectCodex, first.state)
    assert.equal(empty.scanned, 0)
    await appendFile(file, `${codexToken('2026-07-16T23:00:00.000Z', 14)}\n`)
    const delayed = await runAdapter(collectCodex, empty.state, {
      since: '1970-01-01T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
    })
    assert.equal(delayed.records.length, 1)
    assert.equal(delayed.records[0].model, 'gpt-old')
    assert.match(delayed.records[0].dedup_key, /^codex:old:14:/)
    assert.deepEqual(delayed.records[0].attribution, {
      status: 'captured', project: { kind: 'path', value: 'C:\\work\\old-project' },
      session: 'old',
    })
  } finally {
    if (previous == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Grok tail state preserves streaming model context and then empties', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-grok-incremental-'))
  const previous = process.env.GROK_SESSIONS_DIR
  const directory = join(root, 'project', 's1')
  const file = join(directory, 'updates.jsonl')
  process.env.GROK_SESSIONS_DIR = root
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(file, `${grokChunk('grok-tail')}\n`)
    const first = await runAdapter(collectGrok, emptyIncrementalSourceState())
    assert.equal(first.records.length, 0)
    await appendFile(file, `${grokTurn('p1')}\n`)
    const appended = await runAdapter(collectGrok, first.state)
    assert.equal(appended.records[0]?.model, 'grok-tail')
    const empty = await runAdapter(collectGrok, appended.state)
    assert.deepEqual([empty.records.length, empty.scanned], [0, 0])
  } finally {
    if (previous == null) delete process.env.GROK_SESSIONS_DIR
    else process.env.GROK_SESSIONS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('six-hour reconciliation discovers a changed cold Claude session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-claude-reconcile-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    const projects = join(root, 'projects')
    const directory = join(projects, 'cold-project')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'cold.jsonl'),
      `${claudeLine('cold', '2026-07-17T00:00:00.000Z')}\n`,
    )
    const rootStat = await stat(projects)
    const state = emptyIncrementalSourceState()
    const rootKey = incrementalFileKey(projects)
    state.directories[rootKey] = { path: projects, mtime_ms: rootStat.mtimeMs }
    state.hot_directories = [rootKey]
    state.last_reconciled_at = new Date().toISOString()
    const fast = await runClaude(state)
    assert.deepEqual([fast.records.length, fast.scanned], [0, 0])
    fast.state.last_reconciled_at = new Date(Date.now() - 7 * 60 * 60_000).toISOString()
    const reconciled = await runClaude(fast.state)
    assert.deepEqual(reconciled.records.map(row => row.dedup_key), ['claude:cold'])
  } finally {
    if (previous == null) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('fast Grok discovery finds a new session even when hot directories are full', async () => {
  // Production stall: Grok nests terminal/recap under every session and fills
  // the 64-slot hot directory inventory. discoverFast used to refuse enqueueing
  // children once seen+queue hit that limit, so a brand-new sibling session
  // under an already-hot, mtime-changed project directory was skipped until the
  // six-hour reconciliation — permanently if the parent was restaged first.
  const { HOT_DIRECTORY_LIMIT } = await import('../collector-state.js')
  const root = await mkdtemp(join(tmpdir(), 'tokember-grok-hot-full-'))
  const previous = process.env.GROK_SESSIONS_DIR
  process.env.GROK_SESSIONS_DIR = root
  try {
    const project = join(root, 'project-a')
    await mkdir(project, { recursive: true })

    // One real session plus nested noise dirs that saturate hot inventory.
    const seedSession = join(project, 'seed-session')
    await mkdir(join(seedSession, 'terminal'), { recursive: true })
    await writeFile(
      join(seedSession, 'updates.jsonl'),
      `${grokChunk('grok-seed')}\n${grokTurn('seed-1')}\n`,
    )
    for (let i = 0; i < HOT_DIRECTORY_LIMIT; i += 1) {
      await mkdir(join(project, `noise-${String(i).padStart(3, '0')}`, 'terminal'), {
        recursive: true,
      })
    }

    const first = await runAdapter(collectGrok, emptyIncrementalSourceState())
    assert.equal(first.records.length, 1)
    assert.equal(first.records[0]?.dedup_key.includes('seed-1'), true)
    assert.ok(first.state.hot_directories.length <= HOT_DIRECTORY_LIMIT)
    // Force the next run onto the fast path.
    first.state.last_reconciled_at = new Date().toISOString()

    // Keep project + root in the hot set with *stale* mtimes so directoryChanged
    // fires, matching the production cursor shape that still missed new children.
    const projectKey = incrementalFileKey(project)
    const rootKey = incrementalFileKey(root)
    const projectStat = await stat(project)
    const rootStat = await stat(root)
    first.state.directories[projectKey] = {
      path: project, mtime_ms: projectStat.mtimeMs - 1,
    }
    first.state.directories[rootKey] = {
      path: root, mtime_ms: rootStat.mtimeMs - 1,
    }
    const hot = first.state.hot_directories.filter(key => key !== projectKey && key !== rootKey)
    first.state.hot_directories = [projectKey, rootKey, ...hot].slice(0, HOT_DIRECTORY_LIMIT)
    first.state.directories = Object.fromEntries(
      first.state.hot_directories
        .filter(key => first.state.directories[key])
        .map(key => [key, first.state.directories[key]]),
    )

    const freshSession = join(project, 'fresh-session')
    await mkdir(join(freshSession, 'terminal'), { recursive: true })
    await writeFile(
      join(freshSession, 'updates.jsonl'),
      `${grokChunk('grok-fresh')}\n${grokTurn('fresh-1')}\n`,
    )

    const next = await runAdapter(collectGrok, first.state)
    assert.deepEqual(
      next.records.map(row => row.dedup_key).filter(key => key.includes('fresh-1')),
      [`grok:s1:fresh-1:grok-fresh`],
    )
  } finally {
    if (previous == null) delete process.env.GROK_SESSIONS_DIR
    else process.env.GROK_SESSIONS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
