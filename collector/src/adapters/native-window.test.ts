import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { collectClaude } from './claude.js'
import { collectCodex } from './codex.js'

const window = {
  since: '2026-07-15T10:00:00.000Z',
  until: '2026-07-15T11:00:00.000Z',
}

test('Claude adapter excludes native history before the collection window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-burn-claude-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const projects = join(directory, 'projects', 'project')
    await mkdir(projects, { recursive: true })
    const entries = [
      ['old', '2026-07-15T09:59:59.000Z'],
      ['new', '2026-07-15T10:00:00.000Z'],
      ['future', '2026-07-15T11:00:01.000Z'],
    ].map(([id, timestamp]) => JSON.stringify({
      type: 'assistant', timestamp, cwd: 'C:\\work\\project-a', sessionId: 'claude-session',
      message: { id, model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 } },
    }))
    await writeFile(join(projects, 'session.jsonl'), entries.join('\n'))
    const records = await collectClaude(window)
    assert.deepEqual(records.map(record => record.dedup_key), ['claude:new'])
    assert.deepEqual(records[0]?.attribution, {
      status: 'captured', project: { kind: 'path', value: 'C:\\work\\project-a' },
      session: 'claude-session',
    })
  } finally {
    if (previous == null) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex adapter collects appended events from a previous-day session directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-burn-codex-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  try {
    const sessions = join(directory, 'sessions', '2026', '07', '14')
    await mkdir(sessions, { recursive: true })
    const entries = [
      { type: 'session_meta', timestamp: '2026-07-15T09:00:00.000Z', payload: {
        session_id: 's1', model: 'gpt-test', cwd: 'C:\\work\\project-b',
      } },
      tokenEntry('2026-07-15T09:59:59.000Z', 2),
      tokenEntry('2026-07-15T10:00:00.000Z', 4),
      tokenEntry('2026-07-15T11:00:01.000Z', 6),
    ]
    await writeFile(join(sessions, 'rollout-test.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n'))
    const records = await collectCodex(window)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.timestamp, '2026-07-15T10:00:00.000Z')
    assert.equal(records[0]?.cache_read_tokens, 1)
    assert.equal(records[0]?.reasoning_tokens, 2)
    assert.deepEqual(records[0]?.attribution, {
      status: 'captured', project: { kind: 'path', value: 'C:\\work\\project-b' },
      session: 's1',
    })
  } finally {
    if (previous == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
})

function tokenEntry(timestamp: string, total: number) {
  return {
    type: 'event_msg', timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 3,
          cached_input_tokens: 1,
          output_tokens: 1,
          reasoning_output_tokens: 2,
        },
        total_token_usage: { total_tokens: total, input_tokens: total / 2, output_tokens: total / 2 },
      },
    },
  }
}
