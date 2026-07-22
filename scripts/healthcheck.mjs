const url = process.argv[2] ?? 'http://127.0.0.1:3147/api/health/ready'
const expectedRelease = process.argv[3]

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  const body = await response.json()
  const matches = !expectedRelease || body.release_id === expectedRelease
  if (!response.ok || body.status !== 'ready' || !matches) process.exitCode = 1
} catch {
  process.exitCode = 1
}
