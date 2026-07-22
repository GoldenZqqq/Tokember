import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAttributionEncoder } from './attribution.js'
import type { UsageRecord } from './adapters/types.js'

function record(attribution: UsageRecord['attribution']): UsageRecord {
  return {
    provider: 'codex', model: 'gpt-test', input_tokens: 1, output_tokens: 2,
    cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
    cost_usd: 0, timestamp: '2026-07-18T00:00:00.000Z',
    source_file: 'codex', dedup_key: 'codex:1', attribution,
  }
}

test('disabled attribution strips local seeds without creating a secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-attribution-'))
  const secretFile = join(directory, 'secret')
  const encoder = await createAttributionEncoder({ enabled: false, secretFile })
  const encoded = encoder.encode(record({
    status: 'captured', project: { kind: 'path', value: 'C:\\Users\\private\\repo' },
    session: 'raw-session',
  }))

  assert.equal(encoded.attribution_status, 'disabled')
  assert.equal(encoded.project_id, undefined)
  assert.equal(encoded.session_id, undefined)
  assert.equal('attribution' in encoded, false)
  await assert.rejects(() => readFile(secretFile), /ENOENT/)
  assert.doesNotMatch(JSON.stringify(encoded), /private|raw-session/)
})

test('enabled attribution produces stable domain-separated anonymous IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-attribution-'))
  const secretFile = join(directory, 'secret')
  const first = await createAttributionEncoder({ enabled: true, secretFile })
  const second = await createAttributionEncoder({ enabled: true, secretFile })
  const source = record({
    status: 'captured', project: { kind: 'path', value: join(directory, 'repo') },
    session: 'session-1',
  })
  const a = first.encode(source)
  const b = second.encode(source)
  const other = first.encode(record({
    status: 'captured', project: { kind: 'path', value: join(directory, 'other') },
    session: 'session-2',
  }))

  assert.match(a.project_id ?? '', /^prj_v1_[A-Za-z0-9_-]{43}$/)
  assert.match(a.session_id ?? '', /^ses_v1_[A-Za-z0-9_-]{43}$/)
  assert.equal(a.project_id, b.project_id)
  assert.equal(a.session_id, b.session_id)
  assert.notEqual(a.project_id, other.project_id)
  assert.notEqual(a.session_id, other.session_id)
  assert.doesNotMatch(JSON.stringify(a), new RegExp(directory.replaceAll('\\', '\\\\')))
})

test('enabled attribution marks records without reliable seeds unsupported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-attribution-'))
  const encoder = await createAttributionEncoder({
    enabled: true, secretFile: join(directory, 'secret'),
  })
  const encoded = encoder.encode(record({ status: 'unsupported' }))
  assert.deepEqual({
    status: encoded.attribution_status,
    project: encoded.project_id,
    session: encoded.session_id,
  }, { status: 'unsupported', project: undefined, session: undefined })
})
