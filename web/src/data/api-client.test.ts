import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, requestJson } from './api-client'

const decodeOk = (value: unknown) => {
  if (typeof value !== 'object' || value == null || !('ok' in value)) {
    throw new Error('missing ok')
  }
  return value as { ok: boolean }
}

function assertKind(error: unknown, kind: ApiError['kind']): boolean {
  assert.ok(error instanceof ApiError)
  assert.equal(error.kind, kind)
  return true
}

test('requestJson classifies auth and server responses', async () => {
  const auth = () => Promise.resolve(Response.json({ error: '未登录' }, { status: 401 }))
  await assert.rejects(requestJson('/admin', { decode: decodeOk, fetcher: auth }),
    error => assertKind(error, 'auth'))
  const forbidden = () => Promise.resolve(Response.json({ error: '禁止访问' }, { status: 403 }))
  await assert.rejects(requestJson('/admin', { decode: decodeOk, fetcher: forbidden }),
    error => assertKind(error, 'auth'))

  const server = () => Promise.resolve(Response.json({ error: '维护中' }, { status: 500 }))
  await assert.rejects(requestJson('/stats', { decode: decodeOk, fetcher: server }),
    error => assertKind(error, 'server'))
})

test('requestJson rejects non-JSON and invalid successful payloads', async () => {
  const html = () => Promise.resolve(new Response('<html/>', { status: 200 }))
  await assert.rejects(requestJson('/stats', { decode: decodeOk, fetcher: html }),
    error => assertKind(error, 'invalid-response'))

  const invalid = () => Promise.resolve(Response.json({ value: 1 }))
  await assert.rejects(requestJson('/stats', { decode: decodeOk, fetcher: invalid }),
    error => assertKind(error, 'invalid-response'))
})

test('requestJson distinguishes network, timeout and caller abort', async () => {
  const offline = () => Promise.reject(new TypeError('offline'))
  await assert.rejects(requestJson('/stats', { decode: decodeOk, fetcher: offline }),
    error => assertKind(error, 'network'))

  const waitsForAbort = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  await assert.rejects(requestJson('/stats', {
    decode: decodeOk, fetcher: waitsForAbort, timeoutMs: 5,
  }), error => assertKind(error, 'timeout'))

  const controller = new AbortController()
  const request = requestJson('/stats', {
    decode: decodeOk, fetcher: waitsForAbort, signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(request, error => assertKind(error, 'aborted'))
})
