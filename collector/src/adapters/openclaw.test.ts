import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { emptyIncrementalSourceState } from '../collector-state.js'
import { IncrementalCursor } from '../incremental-cursor.js'
import { CollectionObserver } from './types.js'
import { collectOpenClaw } from './openclaw.js'

async function withStateRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'tokember-openclaw-'))
  const previous = process.env.OPENCLAW_STATE_DIR
  process.env.OPENCLAW_STATE_DIR = root
  try {
    return await run(root)
  } finally {
    if (previous == null) delete process.env.OPENCLAW_STATE_DIR
    else process.env.OPENCLAW_STATE_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

test('OpenClaw legacy JSONL emits assistant usage and ignores prompts', async () => {
  await withStateRoot(async root => {
    const sessions = join(root, 'agents', 'main', 'sessions')
    await mkdir(sessions, { recursive: true })
    const sessionFile = join(sessions, 'sess-jsonl.jsonl')
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'sess-jsonl', timestamp: '2026-07-21T08:00:00.000Z' }),
      JSON.stringify({
        type: 'message', id: 'u1', timestamp: '2026-07-21T08:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'do not upload' }] },
      }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-07-21T08:00:02.000Z',
        message: {
          role: 'assistant', model: 'claude-opus',
          usage: { input: 40, output: 10, cacheRead: 5, cost: { total: 0.02 } },
        },
      }),
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(sessions, 'sessions.json'), JSON.stringify({
      main: { sessionId: 'sess-jsonl', sessionFile },
    }), 'utf8')

    const records = await collectOpenClaw()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.provider, 'openclaw')
    assert.equal(records[0]?.model, 'claude-opus')
    assert.equal(records[0]?.input_tokens, 40)
    assert.equal(records[0]?.cache_read_tokens, 5)
    assert.equal(records[0]?.cost_usd, 0.02)
    assert.equal(records[0]?.cost_provided, true)
    assert.equal(records[0]?.dedup_key, 'openclaw:sess-jsonl:a1')
    assert.ok(!JSON.stringify(records).includes('do not upload'))
  })
})

test('OpenClaw SQLite transcript_events are preferred over legacy JSONL duplicates', async () => {
  await withStateRoot(async root => {
    const agentDir = join(root, 'agents', 'main', 'agent')
    const sessions = join(root, 'agents', 'main', 'sessions')
    await mkdir(agentDir, { recursive: true })
    await mkdir(sessions, { recursive: true })

    const dbPath = join(agentDir, 'openclaw-agent.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE transcript_event_identities (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT,
        parent_id TEXT,
        message_idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, event_id)
      );
    `)
    const created = Date.parse('2026-07-21T09:00:00.000Z')
    db.prepare(`
      INSERT INTO sessions(session_id, session_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('sess-sql', 'key', created, created)
    const eventJson = JSON.stringify({
      type: 'message',
      id: 'evt-1',
      timestamp: '2026-07-21T09:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'gpt-openclaw',
        usage: { input: 12, output: 3, cacheRead: 1 },
      },
    })
    db.prepare(`
      INSERT INTO transcript_events(session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run('sess-sql', 1, eventJson, created)
    db.prepare(`
      INSERT INTO transcript_event_identities(
        session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
    `).run('sess-sql', 'evt-1', 1, 'message', created)
    db.close()

    // Legacy archive with the same logical event but different token numbers.
    await writeFile(join(sessions, 'sess-sql.jsonl'), [
      JSON.stringify({ type: 'session', id: 'sess-sql', timestamp: '2026-07-21T09:00:00.000Z' }),
      JSON.stringify({
        type: 'message', id: 'evt-1', timestamp: '2026-07-21T09:00:01.000Z',
        message: {
          role: 'assistant', model: 'legacy-model',
          usage: { input: 999, output: 999 },
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const records = await collectOpenClaw()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.dedup_key, 'openclaw:sess-sql:evt-1')
    assert.equal(records[0]?.model, 'gpt-openclaw')
    assert.equal(records[0]?.input_tokens, 12)
    assert.equal(records[0]?.output_tokens, 3)
  })
})

test('OpenClaw SQLite unchanged signature skips rescans', async () => {
  await withStateRoot(async root => {
    const agentDir = join(root, 'agents', 'main', 'agent')
    await mkdir(agentDir, { recursive: true })
    const dbPath = join(agentDir, 'openclaw-agent.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE transcript_event_identities (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT,
        parent_id TEXT,
        message_idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, event_id)
      );
    `)
    const created = Date.parse('2026-07-21T09:30:00.000Z')
    const eventJson = JSON.stringify({
      type: 'message', id: 'e1', timestamp: '2026-07-21T09:30:01.000Z',
      message: { role: 'assistant', model: 'm', usage: { input: 1, output: 1 } },
    })
    db.prepare(`
      INSERT INTO transcript_events(session_id, seq, event_json, created_at)
      VALUES ('s1', 1, ?, ?)
    `).run(eventJson, created)
    db.prepare(`
      INSERT INTO transcript_event_identities(
        session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
      ) VALUES ('s1', 'e1', 1, 'message', NULL, NULL, ?)
    `).run(created)
    db.close()

    const state = emptyIncrementalSourceState()
    const firstCursor = new IncrementalCursor(state)
    const firstObserver = new CollectionObserver()
    const first = await collectOpenClaw(undefined, firstObserver, firstCursor)
    assert.equal(first.length, 1)
    assert.ok(firstObserver.snapshot().scanned >= 1)

    const secondCursor = new IncrementalCursor(firstCursor.snapshot())
    const secondObserver = new CollectionObserver()
    const second = await collectOpenClaw(undefined, secondObserver, secondCursor)
    assert.equal(second.length, 0)
    assert.equal(secondObserver.snapshot().scanned, 0)
  })
})

test('missing OpenClaw install returns empty', async () => {
  const previous = process.env.OPENCLAW_STATE_DIR
  process.env.OPENCLAW_STATE_DIR = join(tmpdir(), `tokember-openclaw-missing-${Date.now()}`)
  try {
    assert.deepEqual(await collectOpenClaw(), [])
  } finally {
    if (previous == null) delete process.env.OPENCLAW_STATE_DIR
    else process.env.OPENCLAW_STATE_DIR = previous
  }
})
