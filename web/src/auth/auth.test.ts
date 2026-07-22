import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createViewerApi, decodeViewerSession } from './api'
import { ViewerAccess } from './ViewerAccess'

test('viewer API decodes sessions and always includes cookie credentials', async () => {
  let credentials: RequestCredentials | undefined
  const api = createViewerApi('https://tokember.test', async (_input, init) => {
    credentials = init?.credentials
    return new Response(JSON.stringify({ required: true, authenticated: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.deepEqual(await api.session(), { required: true, authenticated: true })
  assert.equal(credentials, 'include')
  assert.throws(() => decodeViewerSession({ authenticated: true }), /boolean/)
})

test('viewer login renders only access copy and keeps admin settings separate', () => {
  const html = renderToStaticMarkup(createElement(ViewerAccess, {
    state: { status: 'anonymous', error: null },
    onLogin: async () => {}, onRetry: () => {}, onSettings: () => {},
  }))
  assert.match(html, /查看 Tokember/)
  assert.match(html, /查看密码/)
  assert.match(html, /管理员设置/)
  assert.doesNotMatch(html, /成本覆盖|尚未计价|预算|来源健康/)
})
