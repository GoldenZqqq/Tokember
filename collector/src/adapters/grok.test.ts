import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { collectGrok } from './grok.js'

function turnCompleted(opts: {
  sessionId: string
  promptId: string
  timestampSec: number
  agentMs?: number
  usage: Record<string, unknown>
  usageIncomplete?: boolean
}): string {
  return JSON.stringify({
    timestamp: opts.timestampSec,
    method: '_x.ai/session/update',
    params: {
      sessionId: opts.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: opts.promptId,
        stop_reason: 'end_turn',
        ...(opts.usageIncomplete ? { usage_is_incomplete: true } : {}),
        usage: opts.usage,
        _meta: opts.agentMs != null
          ? { agentTimestampMs: opts.agentMs, modelId: 'grok-4.5' }
          : undefined,
      },
    },
  })
}

function chunk(modelId: string, totalTokens: number): string {
  return JSON.stringify({
    timestamp: 1784165427,
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
        _meta: { modelId, totalTokens, promptId: 'p1' },
      },
    },
  })
}

async function withSessions(
  write: (sessionsRoot: string) => Promise<void>,
  run: () => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ai-burn-grok-'))
  const previousHome = process.env.GROK_HOME
  const previousSessions = process.env.GROK_SESSIONS_DIR
  process.env.GROK_HOME = root
  delete process.env.GROK_SESSIONS_DIR
  try {
    await write(join(root, 'sessions'))
    await run()
  } finally {
    if (previousHome == null) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previousHome
    if (previousSessions == null) delete process.env.GROK_SESSIONS_DIR
    else process.env.GROK_SESSIONS_DIR = previousSessions
    await rm(root, { recursive: true, force: true })
  }
}

test('collectGrok returns [] when Grok is not installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-burn-grok-empty-'))
  const previous = process.env.GROK_HOME
  process.env.GROK_HOME = join(root, 'missing')
  try {
    const records = await collectGrok()
    assert.deepEqual(records, [])
  } finally {
    if (previous == null) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('collectGrok parses turn_completed modelUsage into UsageRecords', async () => {
  await withSessions(async (sessions) => {
    const dir = join(sessions, 'cwd-encoded', 'sess-1')
    await mkdir(dir, { recursive: true })
    const lines = [
      chunk('grok-4.5', 100),
      turnCompleted({
        sessionId: 'sess-1',
        promptId: 'prompt-aaa',
        timestampSec: 1784165428,
        agentMs: Date.parse('2026-07-16T01:30:28.486Z'),
        usage: {
          inputTokens: 16071,
          outputTokens: 74,
          totalTokens: 16145,
          cachedReadTokens: 0,
          reasoningTokens: 51,
          modelCalls: 1,
          numTurns: 1,
          modelUsage: {
            'grok-4.5': {
              inputTokens: 16071,
              outputTokens: 74,
              totalTokens: 16145,
              cachedReadTokens: 0,
              reasoningTokens: 51,
              modelCalls: 1,
            },
          },
        },
      }),
    ]
    await writeFile(join(dir, 'updates.jsonl'), lines.join('\n') + '\n')
  }, async () => {
    const records = await collectGrok()
    assert.equal(records.length, 1)
    const r = records[0]
    assert.equal(r.provider, 'grok')
    assert.equal(r.model, 'grok-4.5')
    assert.equal(r.input_tokens, 16071)
    assert.equal(r.output_tokens, 74)
    assert.equal(r.cache_read_tokens, 0)
    assert.equal(r.cache_creation_tokens, 0)
    assert.equal(r.reasoning_tokens, 51)
    assert.equal(r.cost_usd, 0)
    assert.equal(r.cost_provided, undefined)
    assert.equal(r.source_file, 'grok-build')
    assert.equal(r.dedup_key, 'grok:sess-1:prompt-aaa:grok-4.5')
    assert.equal(r.timestamp, '2026-07-16T01:30:28.486Z')
  })
})
test('collectGrok splits multi-model modelUsage and attaches per-model cost', async () => {
  await withSessions(async (sessions) => {
    const dir = join(sessions, 'proj', 'sess-multi')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'updates.jsonl'),
      turnCompleted({
        sessionId: 'sess-multi',
        promptId: 'prompt-multi',
        timestampSec: 1_700_000_000,
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cachedReadTokens: 100,
          reasoningTokens: 10,
          modelUsage: {
            'grok-4.5': {
              inputTokens: 800,
              outputTokens: 150,
              cachedReadTokens: 80,
              reasoningTokens: 8,
              costUSD: 0.01,
            },
            'grok-4.5-sub': {
              inputTokens: 200,
              outputTokens: 50,
              cachedReadTokens: 20,
              reasoningTokens: 2,
              costUSD: 0.002,
            },
          },
        },
      }) + '\n',
    )
  }, async () => {
    const records = (await collectGrok()).sort((a, b) => a.model.localeCompare(b.model))
    assert.equal(records.length, 2)
    assert.equal(records[0].model, 'grok-4.5')
    assert.equal(records[0].input_tokens, 800)
    assert.equal(records[0].cost_usd, 0.01)
    assert.equal(records[0].cost_provided, true)
    assert.equal(records[0].dedup_key, 'grok:sess-multi:prompt-multi:grok-4.5')
    assert.equal(records[1].model, 'grok-4.5-sub')
    assert.equal(records[1].input_tokens, 200)
    assert.equal(records[1].cost_provided, true)
  })
})

test('collectGrok skips incomplete usage and non-turn events', async () => {
  await withSessions(async (sessions) => {
    const dir = join(sessions, 'p', 'sess-skip')
    await mkdir(dir, { recursive: true })
    const lines = [
      chunk('grok-4.5', 50),
      turnCompleted({
        sessionId: 'sess-skip',
        promptId: 'bad',
        timestampSec: 1_700_000_100,
        usageIncomplete: true,
        usage: {
          inputTokens: 9,
          outputTokens: 1,
          modelUsage: { 'grok-4.5': { inputTokens: 9, outputTokens: 1 } },
        },
      }),
      turnCompleted({
        sessionId: 'sess-skip',
        promptId: 'good',
        timestampSec: 1_700_000_200,
        usage: {
          inputTokens: 11,
          outputTokens: 2,
          modelUsage: { 'grok-4.5': { inputTokens: 11, outputTokens: 2 } },
        },
      }),
    ]
    await writeFile(join(dir, 'updates.jsonl'), lines.join('\n') + '\n')
  }, async () => {
    const records = await collectGrok()
    assert.deepEqual(records.map(r => r.dedup_key), ['grok:sess-skip:good:grok-4.5'])
  })
})

test('collectGrok falls back to top-level usage and tracked modelId', async () => {
  await withSessions(async (sessions) => {
    const dir = join(sessions, 'p', 'sess-top')
    await mkdir(dir, { recursive: true })
    const lines = [
      chunk('grok-from-chunk', 10),
      turnCompleted({
        sessionId: 'sess-top',
        promptId: 'prompt-top',
        timestampSec: 1_700_000_300,
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          cachedReadTokens: 1,
          reasoningTokens: 0,
          // no modelUsage
        },
      }),
    ]
    await writeFile(join(dir, 'updates.jsonl'), lines.join('\n') + '\n')
  }, async () => {
    const records = await collectGrok()
    assert.equal(records.length, 1)
    assert.equal(records[0].model, 'grok-from-chunk')
    assert.equal(records[0].input_tokens, 5)
    assert.equal(records[0].cache_read_tokens, 1)
    assert.equal(records[0].dedup_key, 'grok:sess-top:prompt-top:grok-from-chunk')
  })
})

test('collectGrok respects collection window on timestamps', async () => {
  // Event times must sit near "now" so the mtime prefilter (skip files not
  // touched since `window.since`) still opens the fixture we just wrote.
  const now = Date.now()
  const oldMs = now - 60 * 60_000
  const inMs = now - 5 * 60_000
  const since = new Date(now - 30 * 60_000).toISOString()
  const until = new Date(now + 60_000).toISOString()

  await withSessions(async (sessions) => {
    const dir = join(sessions, 'p', 'sess-win')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'updates.jsonl'),
      [
        turnCompleted({
          sessionId: 'sess-win',
          promptId: 'old',
          timestampSec: Math.floor(oldMs / 1000),
          agentMs: oldMs,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            modelUsage: { m: { inputTokens: 1, outputTokens: 1 } },
          },
        }),
        turnCompleted({
          sessionId: 'sess-win',
          promptId: 'in',
          timestampSec: Math.floor(inMs / 1000),
          agentMs: inMs,
          usage: {
            inputTokens: 2,
            outputTokens: 2,
            modelUsage: { m: { inputTokens: 2, outputTokens: 2 } },
          },
        }),
      ].join('\n') + '\n',
    )
  }, async () => {
    const records = await collectGrok({ since, until })
    assert.deepEqual(records.map(r => r.dedup_key), ['grok:sess-win:in:m'])
  })
})
