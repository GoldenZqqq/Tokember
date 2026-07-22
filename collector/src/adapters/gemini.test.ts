import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { collectGemini } from './gemini.js'

test('Gemini fixture preserves cache and reasoning inclusion semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-gemini-'))
  const previous = process.env.GEMINI_TMP_DIR
  process.env.GEMINI_TMP_DIR = directory
  try {
    const chats = join(directory, 'project', 'chats')
    await mkdir(chats, { recursive: true })
    await writeFile(join(chats, 'session-fixture.json'), JSON.stringify({
      sessionId: 'session-1',
      startTime: '2026-07-15T10:00:00.000Z',
      messages: [{
        id: 'message-1',
        timestamp: '2026-07-15T10:01:00.000Z',
        type: 'gemini',
        model: 'gemini-test',
        tokens: { input: 100, output: 20, cached: 40, thoughts: 10 },
      }],
    }), 'utf-8')

    const records = await collectGemini()

    assert.equal(records.length, 1)
    assert.deepEqual(records[0], {
      provider: 'gemini',
      model: 'gemini-test',
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 40,
      cache_creation_tokens: 0,
      reasoning_tokens: 10,
      cost_usd: 0,
      timestamp: '2026-07-15T10:01:00.000Z',
      source_file: 'gemini',
      dedup_key: 'gemini:session-1:message-1',
      attribution: {
        status: 'captured',
        project: { kind: 'opaque', value: 'project' },
        session: 'session-1',
      },
    })
  } finally {
    if (previous == null) delete process.env.GEMINI_TMP_DIR
    else process.env.GEMINI_TMP_DIR = previous
    await rm(directory, { recursive: true, force: true })
  }
})
