import { test as setup } from '@playwright/test'

const API = 'http://127.0.0.1:3157/api'
const API_KEY = 'e2e-write-key'
const DEVICE_ID = 'demo-device'

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`E2E seed ${path} failed: ${response.status} ${await response.text()}`)
}

function isoDaysAgo(days: number, hour: number): string {
  const value = new Date(Date.now() - days * 24 * 60 * 60_000)
  value.setUTCHours(hour, 0, 0, 0)
  return value.toISOString()
}

function demoRecords() {
  return [
    { provider: 'codex', model: 'gpt-5.4', input_tokens: 1200, output_tokens: 340, cost_usd: 0.42, cost_provided: true, timestamp: isoDaysAgo(0, 0), dedup_key: 'demo:codex:1' },
    { provider: 'codex', model: 'gpt-5.4', input_tokens: 800, output_tokens: 210, cost_usd: 0.28, cost_provided: true, timestamp: isoDaysAgo(3, 14), dedup_key: 'demo:codex:2' },
    { provider: 'claude', model: 'claude-opus-4-6', input_tokens: 2100, output_tokens: 550, cost_usd: 0.87, cost_provided: true, timestamp: isoDaysAgo(2, 11), dedup_key: 'demo:claude:1' },
    { provider: 'grok-build', model: 'grok-4.5', input_tokens: 600, output_tokens: 180, cost_usd: 0.12, cost_provided: true, timestamp: isoDaysAgo(5, 16), dedup_key: 'demo:grok:1' },
  ].map(record => ({ ...record, request_count: 1, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0 }))
}

setup('seed deterministic demo data', async () => {
  await post('/devices', {
    id: DEVICE_ID,
    name: 'Demo Device',
    native_sources: ['claude', 'codex'],
    protocol_version: 1,
    platform: 'linux',
    architecture: 'x64',
    hostname: 'demo-host',
  })
  await post('/ingest', { device_id: DEVICE_ID, records: demoRecords() })
  await post('/collector-runs', {
    schema_version: 1,
    run_id: 'demo:collector-run:1',
    device_id: DEVICE_ID,
    collector_kind: 'native',
    collector_version: '0.1.0-demo',
    schedule_interval_minutes: 1,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    finished_at: new Date(Date.now() - 29_000).toISOString(),
    status: 'success',
    duration_ms: 1000,
    emitted: 4,
    accepted: 4,
    unchanged: 0,
    error_summary: null,
    sources: [
      { source: 'codex', status: 'success', discovered: 2, scanned: 2, emitted: 2, accepted: 2, unchanged: 0, watermark_at: isoDaysAgo(0, 0), last_usage_at: isoDaysAgo(0, 0), duration_ms: 320, error_summary: null },
      { source: 'claude', status: 'success', discovered: 1, scanned: 1, emitted: 1, accepted: 1, unchanged: 0, watermark_at: isoDaysAgo(2, 11), last_usage_at: isoDaysAgo(2, 11), duration_ms: 280, error_summary: null },
      { source: 'grok-build', status: 'success', discovered: 1, scanned: 1, emitted: 1, accepted: 1, unchanged: 0, watermark_at: isoDaysAgo(5, 16), last_usage_at: isoDaysAgo(5, 16), duration_ms: 240, error_summary: null },
    ],
  })
})
