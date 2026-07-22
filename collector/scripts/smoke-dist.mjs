import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'tokember-smoke-'))
const calls = []

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => respond(request.url, body, response))
})

function respond(path, body, response) {
  calls.push(path)
  response.setHeader('Content-Type', 'application/json')
  if (path === '/api/devices') {
    response.end(JSON.stringify({ ok: true, source_authority: {
      claude: authority('claude'),
      codex: authority('codex'),
    } }))
    return
  }
  if (path === '/api/source-cutovers') {
    response.end(JSON.stringify({ ok: true, created: true }))
    return
  }
  if (path === '/api/ingest') {
    response.end(JSON.stringify({
      ok: true,
      inserted: JSON.parse(body).records?.length ?? 0,
    }))
    return
  }
  if (path === '/api/collector-runs') {
    response.end(JSON.stringify({ ok: true, run_id: JSON.parse(body).run_id }))
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not found' }))
}

function authority(provider) {
  return {
    provider,
    cutover_at: null,
    legacy_history: false,
    legacy_coverage_end: null,
  }
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Smoke server did not bind')

try {
  const code = await runCollector(address.port)
  const cutovers = calls.filter(path => path === '/api/source-cutovers').length
  const runReports = calls.filter(path => path === '/api/collector-runs').length
  if (code !== 0 || cutovers !== 2 || runReports !== 1) {
    throw new Error(`Dist smoke failed: exit=${code}, calls=${JSON.stringify(calls)}`)
  }
  console.log('collector dist smoke passed without cc-switch or CodeBurn')
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(home, { recursive: true, force: true })
}

function runCollector(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TOKEMBER_SERVER: `http://127.0.0.1:${port}`,
        TOKEMBER_API_KEY: 'smoke-test-key',
        TOKEMBER_DEVICE_ID: 'smoke-device',
        TOKEMBER_DEVICE_NAME: 'Smoke Device',
        AI_BURN_COLLECTOR_STATE: join(home, 'state.json'),
        TOKEMBER_OBSERVABILITY_STATE: join(home, 'observability.json'),
        AI_BURN_CACHE_DIR: join(home, 'cache'),
        ANTIGRAVITY_HOME: join(home, '.gemini'),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', reject)
    child.on('close', resolve)
  })
}
