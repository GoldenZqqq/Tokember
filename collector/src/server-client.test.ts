import assert from 'node:assert/strict'
import test from 'node:test'
import type { UsageRecord } from '@tokember/contracts/usage'
import type { CollectorRunReport } from '@tokember/contracts/collector-observability'

import { ServerClient } from './server-client.js'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function inputRecord(index = 1) {
  return {
    provider: 'claude', model: 'model', input_tokens: 1, output_tokens: 1,
    cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
    cost_usd: 0, timestamp: '2026-07-15T00:00:00.000Z',
    source_file: 'claude-code', dedup_key: `claude:${index}`,
  }
}

function runReport(): CollectorRunReport {
  return {
    schema_version: 1, run_id: 'run-1', device_id: 'd1', collector_kind: 'native',
    collector_version: '0.1.0', schedule_interval_minutes: 30,
    started_at: '2026-07-17T00:00:00.000Z', finished_at: '2026-07-17T00:00:01.000Z',
    status: 'success', duration_ms: 1000, emitted: 0, accepted: 0, unchanged: 0,
    error_summary: null,
    sources: [{
      source: 'codex', status: 'success', discovered: 1, scanned: 1,
      emitted: 0, accepted: 0, unchanged: 0, watermark_at: null,
      last_usage_at: null, duration_ms: 900, error_summary: null,
    }],
  }
}

test('server client decodes source authority registration', async () => {
  let body = ''
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = String(init?.body ?? '')
    return jsonResponse({
    ok: true,
    source_authority: {
      claude: {
        provider: 'claude', cutover_at: null,
        legacy_history: true, legacy_coverage_end: '2026-07-15T00:00:00.000Z',
      },
    },
    })
  }
  const client = new ServerClient('https://example.test', 'secret', { fetchImpl })
  const result = await client.registerDevice('d1', 'Device', ['claude'], {
    platform: 'linux', architecture: 'x86_64', hostname: 'machine-1',
  })
  assert.equal(result.claude?.legacy_history, true)
  assert.deepEqual(JSON.parse(body), {
    id: 'd1', name: 'Device', native_sources: ['claude'],
    protocol_version: 1,
    platform: 'linux', architecture: 'x86_64', hostname: 'machine-1',
  })
})

test('server client surfaces protocol incompatible upgrade hint without secrets', async () => {
  const secret = 'device-token-secret-xyz'
  const fetchImpl: typeof fetch = async () => jsonResponse({
    error: 'protocol_incompatible',
    client_protocol_version: 1,
    min_protocol_version: 2,
    max_protocol_version: 2,
    upgrade_hint: 'Upgrade the Tokember collector to support protocol 2.',
  }, 426)
  const client = new ServerClient('https://example.test', secret, { fetchImpl })
  let message = ''
  try {
    await client.registerDevice('d1', 'Device', ['claude'])
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.match(message, /protocol incompatible/)
  assert.match(message, /protocol 2/)
  assert.doesNotMatch(message, new RegExp(secret))
})

test('server client fails the run on HTTP and invalid JSON responses', async () => {
  const httpClient = new ServerClient('https://example.test', '', {
    fetchImpl: async () => jsonResponse({ error: 'temporary failure' }, 503),
  })
  await assert.rejects(() => httpClient.ingest('d1', [inputRecord()]), /HTTP 503/)

  const jsonClient = new ServerClient('https://example.test', '', {
    fetchImpl: async () => new Response('not json', { status: 200 }),
  })
  await assert.rejects(() => jsonClient.ingest('d1', [inputRecord()]), /invalid JSON/)
})

test('server client times out without exposing credential or upstream errors', async () => {
  const secret = 'secret-write-key'
  const fetchImpl: typeof fetch = async (_input, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true })
  })
  const client = new ServerClient('https://example.test', secret, {
    fetchImpl,
    timeoutMs: 5,
  })
  let message = ''
  try {
    await client.ingest('d1', [inputRecord()])
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.match(message, /timed out/)
  assert.doesNotMatch(message, new RegExp(secret))
})

test('server client aggregates exact acknowledgements across chunks', async () => {
  let request = 0
  const fetchImpl: typeof fetch = async () => {
    request += 1
    return request === 1
      ? jsonResponse({
        ok: true, created: 250, updated: 250, unchanged: 0,
        total: 500, inserted: 500,
      })
      : jsonResponse({
        ok: true, created: 0, updated: 0, unchanged: 1,
        total: 1, inserted: 0,
      })
  }
  const client = new ServerClient('https://example.test', '', { fetchImpl })
  const result = await client.ingest(
    'd1', Array.from({ length: 501 }, (_, index) => inputRecord(index)),
  )
  assert.deepEqual(result, {
    precision: 'exact', created: 250, updated: 250, unchanged: 1,
    total: 501, inserted: 500, changed: 500,
  })
})

test('server client rejects incomplete or partial exact acknowledgements', async () => {
  const incomplete = new ServerClient('https://example.test', '', {
    fetchImpl: async () => jsonResponse({ ok: true, inserted: 1, total: 1 }),
  })
  await assert.rejects(() => incomplete.ingest('d1', [inputRecord()]), /invalid acknowledgement/)

  const partial = new ServerClient('https://example.test', '', {
    fetchImpl: async () => jsonResponse({
      ok: true, created: 0, updated: 0, unchanged: 0, total: 0, inserted: 0,
    }),
  })
  await assert.rejects(() => partial.ingest('d1', [inputRecord()]), /partial acknowledgement/)
})

test('server client supports legacy inserted responses without faking exact counts', async () => {
  let payload: { records: UsageRecord[] } | undefined
  const fetchImpl: typeof fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as { records: UsageRecord[] }
    return jsonResponse({ ok: true, inserted: 2 })
  }
  const client = new ServerClient('https://example.test', '', { fetchImpl })
  const base = {
    model: 'model', input_tokens: 10, output_tokens: 2,
    cache_read_tokens: 4, cache_creation_tokens: 0, reasoning_tokens: 1,
    cost_usd: 0, timestamp: '2026-07-15T00:00:00.000Z', source_file: 'fixture',
  }
  const result = await client.ingest('d1', [
    { ...base, provider: 'codex', dedup_key: 'codex:1' },
    { ...base, provider: 'hermes', request_count: 3, dedup_key: 'hermes:1' },
  ])
  assert.deepEqual(result, {
    precision: 'legacy', total: 2, inserted: 2, changed: 2,
  })
  assert.ok(payload)
  assert.deepEqual(payload.records.map(record => ({
    provider: record.provider,
    request_count: record.request_count,
    input_includes_cache_read: record.input_includes_cache_read,
    output_includes_reasoning: record.output_includes_reasoning,
  })), [
    { provider: 'codex', request_count: 1, input_includes_cache_read: true, output_includes_reasoning: false },
    { provider: 'hermes', request_count: 3, input_includes_cache_read: false, output_includes_reasoning: false },
  ])
})

test('server client never serializes local attribution seeds', async () => {
  let body = ''
  const client = new ServerClient('https://example.test', '', {
    fetchImpl: async (_input, init) => {
      body = String(init?.body)
      return jsonResponse({
        ok: true, created: 1, updated: 0, unchanged: 0, total: 1, inserted: 1,
      })
    },
  })
  await client.ingest('d1', [{
    ...inputRecord(),
    attribution: {
      status: 'captured',
      project: { kind: 'path', value: 'C:\\Users\\private\\repo' },
      session: 'raw-session',
    },
    attribution_version: 1,
    attribution_status: 'captured',
    project_id: 'prj_v1_safe',
    session_id: 'ses_v1_safe',
  }])
  assert.doesNotMatch(body, /private|raw-session|"attribution"/)
  assert.match(body, /prj_v1_safe/)
})

test('server client sends and verifies idempotent collector run reports', async () => {
  let path = ''
  let authorization = ''
  const fetchImpl: typeof fetch = async (input, init) => {
    path = String(input)
    authorization = new Headers(init?.headers).get('Authorization') ?? ''
    const payload = JSON.parse(String(init?.body)) as CollectorRunReport
    return jsonResponse({ ok: true, run_id: payload.run_id })
  }
  const client = new ServerClient('https://example.test/', 'write-key', { fetchImpl })
  assert.deepEqual(await client.reportRun(runReport()), { ok: true, run_id: 'run-1' })
  assert.equal(path, 'https://example.test/api/collector-runs')
  assert.equal(authorization, 'Bearer write-key')

  const invalid = new ServerClient('https://example.test', '', {
    fetchImpl: async () => jsonResponse({ ok: true, run_id: 'other' }),
  })
  await assert.rejects(() => invalid.reportRun(runReport()), /invalid acknowledgement/)
})
